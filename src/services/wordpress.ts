import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import {
  findNewsRegion,
  newsRegionTagParam,
  newsRegions
} from "../lib/news-regions.js";

/**
 * Reads podcast and video listings from the WordPress REST API.
 *
 * The mobile app cannot call WordPress directly: Cloudflare rejects non-browser
 * clients from the public internet with an empty 403. This server sits inside
 * the network that is (or will be) allowlisted, so it fetches WordPress and
 * re-serves a stable, app-shaped payload.
 */

export type PodcastItem = {
  audio_url: string | null;
  duration: string | null;
  episode_number: string | null;
  id: number;
  image_url: string | null;
  is_premium: boolean;
  link: string;
  published_at: string | null;
  title: string;
};

export type VideoItem = {
  description: string | null;
  id: number;
  image_url: string | null;
  is_premium: boolean;
  link: string;
  published_at: string | null;
  title: string;
  youtube_id: string | null;
};

export type AnalystOpinionItem = {
  excerpt: string | null;
  id: number;
  image_url: string | null;
  link: string;
  published_at: string | null;
  title: string;
};

export type AnalystOpinionDetail = AnalystOpinionItem & {
  body: string;
  body_html: string | null;
};

export type MediaPage<T> = { items: T[]; total: number };

type EmbeddedMedia = {
  source_url?: string;
  media_details?: { sizes?: Record<string, { source_url?: string } | undefined> };
};

type WordPressPost = {
  _embedded?: { "wp:featuredmedia"?: EmbeddedMedia[] };
  content?: { rendered?: string };
  date_gmt?: string;
  excerpt?: { rendered?: string };
  id: number;
  link?: string;
  modified_gmt?: string;
  title?: { rendered?: string };
};

const listFields = "id,date_gmt,modified_gmt,link,title,content,_links,_embedded";
const youtubeIdCacheTtlMs = 24 * 60 * 60 * 1000;
const entityPattern = /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi;
const namedEntities: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"'
};

export function decodeEntities(value: string): string {
  return value.replace(entityPattern, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    }
    return namedEntities[entity.toLowerCase()] ?? match;
  });
}

export function toText(html = ""): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** Keeps paragraph and list breaks so the app can render readable body text. */
export function htmlToPlainText(html = ""): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<img[^>]*>/gi, "")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** WordPress reports GMT timestamps without a zone designator. */
function toIsoTimestamp(dateGmt?: string): string | null {
  if (!dateGmt) return null;
  const value = new Date(dateGmt.endsWith("Z") ? dateGmt : `${dateGmt}Z`);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

function featuredImage(post: WordPressPost): string | null {
  const media = post._embedded?.["wp:featuredmedia"]?.[0];
  const sizes = media?.media_details?.sizes;
  return (
    sizes?.medium_large?.source_url ??
    sizes?.large?.source_url ??
    sizes?.medium?.source_url ??
    media?.source_url ??
    null
  );
}

type CacheEntry<T> = { expiresAt: number; value: T };
const cache = new Map<string, CacheEntry<unknown>>();

async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    // Map iteration order is insertion order. Touching a hit makes the entry
    // most-recently-used so capacity eviction removes genuinely cold data.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value as T;
  }
  if (hit) cache.delete(key);

  const value = await load();
  if (ttlMs > 0) {
    const insertionTime = Date.now();

    // Expired keys used to remain forever unless that exact key was requested
    // again. A public caller could therefore fill memory with unique searches.
    for (const [candidateKey, entry] of cache) {
      if (entry.expiresAt <= insertionTime) cache.delete(candidateKey);
    }

    const maximumEntries = config().MEDIA_CACHE_MAX_ENTRIES;
    while (cache.size >= maximumEntries) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }

    cache.set(key, { expiresAt: insertionTime + ttlMs, value });
  }
  return value;
}

/** Exposed for tests and for operational cache busting. */
export function clearMediaCache(): void {
  cache.clear();
}

async function wordPressRequest(url: URL, accept: string): Promise<Response> {
  const env = config();
  const configuredOrigin = new URL(env.WORDPRESS_BASE_URL).origin;
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": env.WORDPRESS_USER_AGENT
  };
  if (env.WORDPRESS_BYPASS_HEADER && env.WORDPRESS_BYPASS_VALUE) {
    headers[env.WORDPRESS_BYPASS_HEADER] = env.WORDPRESS_BYPASS_VALUE;
  }

  let currentUrl = url;

  // Fetch follows redirects by default. That is unsafe for the private WAF
  // bypass header: a compromised WordPress response could redirect to another
  // host and receive the credential. Handle redirects ourselves and require
  // every hop to remain on the configured WordPress origin.
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (currentUrl.origin !== configuredOrigin) {
      throw new HttpError(
        502,
        "WordPress returned an external URL",
        "WORDPRESS_EXTERNAL_URL"
      );
    }

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(env.WORDPRESS_TIMEOUT_MS)
      });
    } catch (error) {
      throw new HttpError(
        502,
        `WordPress request failed: ${(error as Error).message}`,
        "WORDPRESS_UNREACHABLE"
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === 5) {
        throw new HttpError(502, "WordPress returned an invalid redirect", "WORDPRESS_UNAVAILABLE");
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    if (!response.ok) {
      throw new HttpError(
        502,
        `WordPress returned ${response.status} for ${currentUrl.pathname}`,
        "WORDPRESS_UNAVAILABLE"
      );
    }
    return response;
  }

  throw new HttpError(502, "WordPress returned too many redirects", "WORDPRESS_UNAVAILABLE");
}

async function fetchPostType(
  restBase: string,
  page: number,
  limit: number,
  options: { fields?: string; params?: Record<string, string> } = {}
): Promise<{ posts: WordPressPost[]; total: number }> {
  const url = new URL(`/wp-json/wp/v2/${restBase}`, config().WORDPRESS_BASE_URL);
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(limit));
  url.searchParams.set("_embed", "wp:featuredmedia");
  url.searchParams.set("_fields", options.fields ?? listFields);

  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await wordPressRequest(url, "application/json");
  const posts = (await response.json()) as WordPressPost[];
  return {
    posts: Array.isArray(posts) ? posts : [],
    total: Number(response.headers.get("x-wp-total") ?? 0)
  };
}

/**
 * Buzzsprout embeds its player as a script tag; the matching audio file shares
 * the script's path with an .mp3 extension.
 */
const buzzsproutPattern = /buzzsprout\.com\/(\d+)\/episodes\/(\d+)-([a-z0-9-]+)\.js/i;

function podcastAudio(html = ""): { audioUrl: string | null; episodeNumber: string | null } {
  const match = buzzsproutPattern.exec(html);
  if (!match) return { audioUrl: null, episodeNumber: null };
  const [, showId, episodeId, slug] = match;
  return {
    audioUrl: `https://www.buzzsprout.com/${showId}/episodes/${episodeId}-${slug}.mp3`,
    episodeNumber: /^ep(\d+)-/i.exec(slug ?? "")?.[1] ?? null
  };
}

function toPodcast(post: WordPressPost): PodcastItem {
  const { audioUrl, episodeNumber } = podcastAudio(post.content?.rendered);
  return {
    audio_url: audioUrl,
    // WordPress does not store episode length; the player reports it on play.
    duration: null,
    episode_number: episodeNumber,
    id: post.id,
    image_url: featuredImage(post),
    // Metered Insights content: the listing withholds audio_url and the
    // detail route serves it after the free-read check. Kept in the payload
    // so existing consumers do not break on a missing field; nothing reads it.
    is_premium: true,
    link: post.link ?? "",
    published_at: toIsoTimestamp(post.date_gmt),
    title: toText(post.title?.rendered)
  };
}

const youtubePattern =
  /(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{6,})/;

/**
 * The videos post type stores its embed in hidden oEmbed post meta, which the
 * REST response omits, so the rendered permalink is the only reliable source.
 * Results are cached per revision because this costs one request per video.
 */
async function resolveYoutubeId(post: WordPressPost): Promise<string | null> {
  const inline = youtubePattern.exec(post.content?.rendered ?? "")?.[1];
  if (inline) return inline;
  if (!post.link) return null;

  const key = `youtube:${post.id}:${post.modified_gmt ?? ""}`;
  return cached(key, youtubeIdCacheTtlMs, async () => {
    try {
      const response = await wordPressRequest(new URL(post.link!), "text/html");
      return youtubePattern.exec(await response.text())?.[1] ?? null;
    } catch {
      // A single unreachable permalink must not fail the whole listing.
      return null;
    }
  });
}

function videoDescription(post: WordPressPost): string | null {
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(post.content?.rendered ?? "")?.[1];
  const text = toText(paragraph ?? post.content?.rendered);
  if (!text) return null;
  return text.length > 300 ? `${text.slice(0, 297).trimEnd()}...` : text;
}

export type NewsItem = {
  excerpt: string | null;
  id: number;
  image_url: string | null;
  link: string;
  published_at: string | null;
  title: string;
};

export type NewsCategoryItem = {
  count: number;
  id: number;
  name: string;
};

/**
 * The feed omits article bodies: including them nearly doubles the page to
 * carry text the list never renders. Bodies are served by getArticleBody.
 */
const newsListFields = "id,date_gmt,link,title,excerpt,_links,_embedded";

/** Start of the rolling news window, as WordPress-compatible ISO 8601. */
function newsWindowStart(months: number): string {
  const start = new Date();
  start.setMonth(start.getMonth() - months);
  return start.toISOString().slice(0, 19);
}

export async function listNews(
  page: number,
  limit: number,
  categoryId?: number,
  regionSlug?: string
): Promise<MediaPage<NewsItem>> {
  const months = config().NEWS_WINDOW_MONTHS;
  const region = findNewsRegion(regionSlug);
  const key = `news:${page}:${limit}:${categoryId ?? "all"}:${region?.slug ?? "all"}`;

  return cached(key, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const params: Record<string, string> = { after: newsWindowStart(months) };
    if (categoryId) params.categories = String(categoryId);
    // Comma-separated tag ids are OR in the WordPress REST API, which is what
    // a region needs: any one of its spellings counts as a match.
    if (region) params.tags = newsRegionTagParam(region);

    const { posts, total } = await fetchPostType("ibsi_news", page, limit, {
      fields: newsListFields,
      params
    });

    const items = posts.map((post) => ({
      excerpt: toText(post.excerpt?.rendered) || null,
      id: post.id,
      image_url: featuredImage(post),
      link: post.link ?? "",
      published_at: toIsoTimestamp(post.date_gmt),
      title: toText(post.title?.rendered)
    }));

    return { items, total };
  });
}

/**
 * Search runs over the whole archive rather than the rolling window the feed
 * uses: someone looking for a named deal or vendor usually wants the piece
 * that ran two years ago, not only what is recent. Results are cached per
 * term and page, so a popular query costs WordPress one request, not one per
 * reader - which is the point of routing search through here at all.
 */
export async function searchNews(
  term: string,
  page: number,
  limit: number,
  categoryId?: number,
  regionSlug?: string
): Promise<MediaPage<NewsItem>> {
  const query = term.trim();
  const region = findNewsRegion(regionSlug);
  const key = `news:search:${query.toLowerCase()}:${page}:${limit}:${categoryId ?? "all"}:${region?.slug ?? "all"}`;

  return cached(key, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const params: Record<string, string> = { orderby: "relevance", search: query };
    if (categoryId) params.categories = String(categoryId);
    if (region) params.tags = newsRegionTagParam(region);

    const { posts, total } = await fetchPostType("ibsi_news", page, limit, {
      fields: newsListFields,
      params
    });

    const items = posts.map((post) => ({
      excerpt: toText(post.excerpt?.rendered) || null,
      id: post.id,
      image_url: featuredImage(post),
      link: post.link ?? "",
      published_at: toIsoTimestamp(post.date_gmt),
      title: toText(post.title?.rendered)
    }));

    return { items, total };
  });
}

/**
 * How many news stories a set of tags has in the current window.
 *
 * Deliberately not fetchPostType: that asks for `_embed` and the full list
 * fields to build items nobody reads here. This wants one number, so it asks
 * for one id and reads the count out of the header.
 */
async function countNewsByTags(tagIds: number[], after: string): Promise<number> {
  const url = new URL("/wp-json/wp/v2/ibsi_news", config().WORDPRESS_BASE_URL);
  url.searchParams.set("per_page", "1");
  url.searchParams.set("_fields", "id");
  url.searchParams.set("after", after);
  url.searchParams.set("tags", tagIds.join(","));

  const response = await wordPressRequest(url, "application/json");
  return Number(response.headers.get("x-wp-total") ?? 0);
}

/**
 * The regions the app may filter by, with a live count each.
 *
 * The counts are the point. Topic and region are independent, and narrow
 * combinations collapse hard - Payments alone runs to ~990 stories a year,
 * Payments in Africa to 17. Sending the numbers lets the app show what a
 * region is worth before the reader commits to it, instead of presenting
 * seven equal-looking choices and emptying the feed for three of them.
 *
 * `tagIds` goes out too, and is not an implementation leak: the app falls back
 * to calling WordPress directly when this API is unreachable, and without the
 * ids that fallback would quietly drop the region and serve global news under
 * a region heading.
 */
export type NewsRegionItem = {
  count: number;
  name: string;
  slug: string;
  tag_ids: number[];
};

export async function listNewsRegions(): Promise<NewsRegionItem[]> {
  return cached("news:regions", config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const after = newsWindowStart(config().NEWS_WINDOW_MONTHS);
    const items: NewsRegionItem[] = [];

    // Sequential, not Promise.all. Seven simultaneous requests is exactly the
    // burst Cloudflare drops one of, and it does so silently - the observed
    // failure was a single region returning nothing while the other six were
    // fine. One at a time costs a few seconds on a cache miss and nothing
    // afterwards.
    for (const region of newsRegions) {
      const count = await countNewsByTags(region.tagIds, after).catch(() =>
        // One retry, because the failure is transient by nature.
        countNewsByTags(region.tagIds, after)
      );

      items.push({
        count,
        name: region.name,
        slug: region.slug,
        tag_ids: region.tagIds
      });
    }

    return items;
  });
}

export async function listNewsCategories(): Promise<NewsCategoryItem[]> {
  return cached("news:categories", config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const url = new URL("/wp-json/wp/v2/categories", config().WORDPRESS_BASE_URL);
    url.searchParams.set("per_page", String(config().NEWS_TOPIC_COUNT));
    url.searchParams.set("orderby", "count");
    url.searchParams.set("order", "desc");
    url.searchParams.set("_fields", "id,name,count");

    const response = await wordPressRequest(url, "application/json");
    const payload = (await response.json()) as NewsCategoryItem[];

    if (!Array.isArray(payload)) return [];

    return payload
      .filter((category) => category.count > 0)
      .map((category) => ({
        count: category.count,
        id: category.id,
        name: toText(String(category.name))
      }));
  });
}

/** One article's body, as plain text ready for the app to render. */
export type ArticleContent = { html: string | null; text: string | null };
export type ArticleMetadata = {
  headline: string;
  image_url: string | null;
};

/**
 * The mobile app prefixes WordPress IDs with `postid-`. WordPress itself only
 * accepts the numeric portion in its REST path.
 */
function wordPressArticleId(articleId: string): string {
  return articleId.replace(/^postid-/i, "");
}

/** Resolves notification copy and artwork from the canonical WordPress post. */
export async function getArticleMetadata(articleId: string): Promise<ArticleMetadata | null> {
  return cached(
    `news:article-metadata:${articleId}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const url = new URL(
        `/wp-json/wp/v2/ibsi_news/${encodeURIComponent(wordPressArticleId(articleId))}`,
        config().WORDPRESS_BASE_URL
      );
      url.searchParams.set("_embed", "wp:featuredmedia");
      url.searchParams.set("_fields", "id,title,_links,_embedded");

      const response = await wordPressRequest(url, "application/json");
      const post = (await response.json()) as WordPressPost;
      const headline = toText(post.title?.rendered);
      return headline ? { headline, image_url: featuredImage(post) } : null;
    }
  );
}

/**
 * Both renderings of the body. `text` is what every shipped app build reads and
 * must keep working; `html` is the same content unflattened, so a newer client
 * can render the headings, links and inline images that htmlToPlainText throws
 * away. The cache key is versioned because the cached value used to be a bare
 * string.
 */
export async function getArticleContent(articleId: string): Promise<ArticleContent | null> {
  return cached(
    `news:article:v2:${articleId}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const url = new URL(
        `/wp-json/wp/v2/ibsi_news/${encodeURIComponent(wordPressArticleId(articleId))}`,
        config().WORDPRESS_BASE_URL
      );
      url.searchParams.set("_fields", "id,content");

      const response = await wordPressRequest(url, "application/json");
      const post = (await response.json()) as WordPressPost;
      const html = post.content?.rendered ?? null;
      const text = htmlToPlainText(post.content?.rendered) || null;

      return text || html ? { html, text } : null;
    }
  );
}

export async function getArticleBody(articleId: string): Promise<string | null> {
  return (await getArticleContent(articleId))?.text ?? null;
}

export async function listPodcasts(page: number, limit: number): Promise<MediaPage<PodcastItem>> {
  return cached(`podcasts:${page}:${limit}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const { posts, total } = await fetchPostType("podcasts", page, limit);
    return { items: posts.map(toPodcast), total };
  });
}

// Galaxy screen content is no longer fetched live from here - this server's
// outbound requests to WordPress are blocked by Cloudflare bot protection.
// See src/lib/galaxy-content.ts and src/services/galaxyContent.ts.

function toVideo(post: WordPressPost, youtubeId: string | null): VideoItem {
  return {
    description: videoDescription(post),
    id: post.id,
    image_url: featuredImage(post),
    // Metered, as with podcasts above.
    is_premium: true,
    link: post.link ?? "",
    published_at: toIsoTimestamp(post.date_gmt),
    title: toText(post.title?.rendered),
    youtube_id: youtubeId
  };
}

/**
 * No YouTube id on the listing. Resolving one costs a permalink fetch per
 * video, and the listing never shows it now that playback is metered: the
 * reader opens one video, and getVideo resolves that one.
 */
export async function listVideos(page: number, limit: number): Promise<MediaPage<VideoItem>> {
  return cached(`videos:${page}:${limit}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const { posts, total } = await fetchPostType("videos", page, limit);
    return { items: posts.map((post) => toVideo(post, null)), total };
  });
}

/**
 * One post by id, with the same fields the listings read. A WordPress 404
 * surfaces from wordPressRequest as a 502, which is wrong for "no such post";
 * the callers below turn a missing id into null and the route into a 404.
 */
async function fetchPost(restBase: string, postId: string): Promise<WordPressPost | null> {
  const url = new URL(
    `/wp-json/wp/v2/${restBase}/${encodeURIComponent(postId)}`,
    config().WORDPRESS_BASE_URL
  );
  url.searchParams.set("_embed", "wp:featuredmedia");
  url.searchParams.set("_fields", listFields);

  try {
    const response = await wordPressRequest(url, "application/json");
    const post = (await response.json()) as WordPressPost;
    return post?.id ? post : null;
  } catch (error) {
    if (error instanceof HttpError && /returned 404 /.test(error.message)) return null;
    throw error;
  }
}

/** The one podcast the reader opened, audio URL included. */
export async function getPodcast(podcastId: string): Promise<PodcastItem | null> {
  return cached(`podcast:${podcastId}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const post = await fetchPost("podcasts", podcastId);
    return post ? toPodcast(post) : null;
  });
}

/** The one video the reader opened, YouTube id resolved. */
export async function getVideo(videoId: string): Promise<VideoItem | null> {
  return cached(`video:${videoId}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const post = await fetchPost("videos", videoId);
    return post ? toVideo(post, await resolveYoutubeId(post)) : null;
  });
}

/**
 * Webinars: the `webinars` post type, a YouTube embed behind a featured image
 * exactly like a video, so they share the video shape. Free to watch, hence
 * `is_premium: false` - the app reads that flag, and nothing meters them.
 *
 * The listing still omits the YouTube id, for cost rather than access:
 * resolving one is a permalink fetch per row, and only the webinar the reader
 * opens needs it. getWebinar resolves that one.
 */
function toWebinar(post: WordPressPost, youtubeId: string | null): VideoItem {
  return { ...toVideo(post, youtubeId), is_premium: false };
}

export async function listWebinars(page: number, limit: number): Promise<MediaPage<VideoItem>> {
  return cached(`webinars:${page}:${limit}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const { posts, total } = await fetchPostType("webinars", page, limit);
    return { items: posts.map((post) => toWebinar(post, null)), total };
  });
}

/** The one webinar the reader opened, YouTube id resolved. */
export async function getWebinar(webinarId: string): Promise<VideoItem | null> {
  return cached(`webinar:${webinarId}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const post = await fetchPost("webinars", webinarId);
    return post ? toWebinar(post, await resolveYoutubeId(post)) : null;
  });
}

/**
 * The free editorial collections - Analyst Opinions and Leadership Interviews -
 * are each a WordPress post type with the same shape: a title, an excerpt, a
 * featured image and a body. They differ only in the REST base they live under,
 * so one pair of readers serves both, keyed by post type so the caches never
 * cross.
 */
type EditorialPostType = {
  /** Prefix for cache keys. Must differ per post type. */
  cachePrefix: string;
  /** The `rest_base` WordPress registered for the post type. */
  restBase: string;
};

const analystOpinionPostType: EditorialPostType = {
  cachePrefix: "analyst-opinion",
  restBase: "articles"
};

/**
 * Registered under the singular slug, as WordPress reports it from
 * /wp-json/wp/v2/types; the site's own listing lives at /leadership-interviews/.
 */
const leadershipInterviewPostType: EditorialPostType = {
  cachePrefix: "leadership-interview",
  restBase: "leadership-interview"
};

async function listEditorialPosts(
  type: EditorialPostType,
  page: number,
  limit: number
): Promise<MediaPage<AnalystOpinionItem>> {
  return cached(
    `${type.cachePrefix}s:${page}:${limit}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const { posts, total } = await fetchPostType(type.restBase, page, limit, {
        fields: "id,date_gmt,link,title,excerpt,_links,_embedded"
      });
      return {
        items: posts.map((post) => ({
          excerpt: toText(post.excerpt?.rendered) || null,
          id: post.id,
          image_url: featuredImage(post),
          link: post.link ?? "",
          published_at: toIsoTimestamp(post.date_gmt),
          title: toText(post.title?.rendered)
        })),
        total
      };
    }
  );
}

async function getEditorialPost(
  type: EditorialPostType,
  postId: string
): Promise<AnalystOpinionDetail | null> {
  const wordpressId = postId.replace(/^postid-/i, "");
  return cached(
    `${type.cachePrefix}:${wordpressId}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const url = new URL(
        `/wp-json/wp/v2/${type.restBase}/${encodeURIComponent(wordpressId)}`,
        config().WORDPRESS_BASE_URL
      );
      url.searchParams.set("_embed", "wp:featuredmedia");
      url.searchParams.set(
        "_fields",
        "id,date_gmt,link,title,excerpt,content,_links,_embedded"
      );

      const response = await wordPressRequest(url, "application/json");
      const post = (await response.json()) as WordPressPost;
      const bodyHtml = post.content?.rendered ?? null;
      const body = htmlToPlainText(bodyHtml ?? "");
      if (!post.id || !body) return null;

      return {
        body,
        body_html: bodyHtml,
        excerpt: toText(post.excerpt?.rendered) || null,
        id: post.id,
        image_url: featuredImage(post),
        link: post.link ?? "",
        published_at: toIsoTimestamp(post.date_gmt),
        title: toText(post.title?.rendered)
      };
    }
  );
}

/**
 * IBSi Views / Analyst Opinions are WordPress `articles` posts. They are free
 * Insights content, so both the listing and complete article body are public.
 */
export async function listAnalystOpinions(
  page: number,
  limit: number
): Promise<MediaPage<AnalystOpinionItem>> {
  return listEditorialPosts(analystOpinionPostType, page, limit);
}

export async function getAnalystOpinion(
  opinionId: string
): Promise<AnalystOpinionDetail | null> {
  return getEditorialPost(analystOpinionPostType, opinionId);
}

/**
 * Leadership Interviews: IBSi's conversations with banking and FinTech
 * leaders, a `leadership-interview` post type. Free, like analyst opinions, and
 * served in the same shape so the app reads both with one parser.
 */
export type LeadershipInterviewItem = AnalystOpinionItem;
export type LeadershipInterviewDetail = AnalystOpinionDetail;

export async function listLeadershipInterviews(
  page: number,
  limit: number
): Promise<MediaPage<LeadershipInterviewItem>> {
  return listEditorialPosts(leadershipInterviewPostType, page, limit);
}

export async function getLeadershipInterview(
  interviewId: string
): Promise<LeadershipInterviewDetail | null> {
  return getEditorialPost(leadershipInterviewPostType, interviewId);
}
