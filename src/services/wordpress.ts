import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";

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

function decodeEntities(value: string): string {
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

function toText(html = ""): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** Keeps paragraph and list breaks so the app can render readable body text. */
function htmlToPlainText(html = ""): string {
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
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await load();
  if (ttlMs > 0) cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

/** Exposed for tests and for operational cache busting. */
export function clearMediaCache(): void {
  cache.clear();
}

async function wordPressRequest(url: URL, accept: string): Promise<Response> {
  const env = config();
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": env.WORDPRESS_USER_AGENT
  };
  if (env.WORDPRESS_BYPASS_HEADER && env.WORDPRESS_BYPASS_VALUE) {
    headers[env.WORDPRESS_BYPASS_HEADER] = env.WORDPRESS_BYPASS_VALUE;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(env.WORDPRESS_TIMEOUT_MS)
    });
  } catch (error) {
    throw new HttpError(
      502,
      `WordPress request failed: ${(error as Error).message}`,
      "WORDPRESS_UNREACHABLE"
    );
  }
  if (!response.ok) {
    throw new HttpError(
      502,
      `WordPress returned ${response.status} for ${url.pathname}`,
      "WORDPRESS_UNAVAILABLE"
    );
  }
  return response;
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

/** Bounded concurrency keeps a page of videos from opening 50 sockets at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
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
  categoryId?: number
): Promise<MediaPage<NewsItem>> {
  const months = config().NEWS_WINDOW_MONTHS;
  const key = `news:${page}:${limit}:${categoryId ?? "all"}`;

  return cached(key, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const params: Record<string, string> = { after: newsWindowStart(months) };
    if (categoryId) params.categories = String(categoryId);

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
export async function getArticleBody(articleId: string): Promise<string | null> {
  return cached(`news:article:${articleId}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const url = new URL(
      `/wp-json/wp/v2/ibsi_news/${encodeURIComponent(articleId)}`,
      config().WORDPRESS_BASE_URL
    );
    url.searchParams.set("_fields", "id,content");

    const response = await wordPressRequest(url, "application/json");
    const post = (await response.json()) as WordPressPost;
    return htmlToPlainText(post.content?.rendered) || null;
  });
}

export async function listPodcasts(page: number, limit: number): Promise<MediaPage<PodcastItem>> {
  return cached(`podcasts:${page}:${limit}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const { posts, total } = await fetchPostType("podcasts", page, limit);
    return { items: posts.map(toPodcast), total };
  });
}

export async function listVideos(page: number, limit: number): Promise<MediaPage<VideoItem>> {
  return cached(`videos:${page}:${limit}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const { posts, total } = await fetchPostType("videos", page, limit);
    const items = await mapWithConcurrency(posts, 6, async (post) => ({
      description: videoDescription(post),
      id: post.id,
      image_url: featuredImage(post),
      is_premium: true,
      link: post.link ?? "",
      published_at: toIsoTimestamp(post.date_gmt),
      title: toText(post.title?.rendered),
      youtube_id: await resolveYoutubeId(post)
    }));
    return { items, total };
  });
}
