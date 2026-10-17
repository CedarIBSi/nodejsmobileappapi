import { config } from "../config.js";
import { HttpError } from "../lib/errors.js";
import { load } from "cheerio";
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
  /** The guest author named in the post's own "By …" line; null when there is none. */
  author_name: string | null;
  /** What they are: "Director of Global Advisory at BioCatch". */
  author_role: string | null;
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

export type BlogItem = AnalystOpinionItem;
export type BlogDetail = AnalystOpinionDetail;
export type CaseStudyItem = AnalystOpinionItem;
export type CaseStudyDetail = AnalystOpinionDetail;
export type InsightTopic = { id: number; name: string };

export type MediaPage<T> = { items: T[]; total: number };

export type ResearchReportItem = {
  id: number | string;
  image_url: string | null;
  title: string;
};

export type ResearchReportSection = {
  content_html: string;
  key: string;
  title: string;
};

export type ResearchReportDetail = ResearchReportItem & {
  description_html: string | null;
  page_count: number | null;
  sections: ResearchReportSection[];
};

type EmbeddedMedia = {
  source_url?: string;
  media_details?: { sizes?: Record<string, { source_url?: string } | undefined> };
};

type EmbeddedAuthor = { name?: string };
type EmbeddedTerm = { id?: number; name?: string; taxonomy?: string };

type WordPressPost = {
  _embedded?: {
    author?: EmbeddedAuthor[];
    "wp:featuredmedia"?: EmbeddedMedia[];
    /** One array per taxonomy the post has terms in: categories, then tags. */
    "wp:term"?: EmbeddedTerm[][];
  };
  /** ACF fields, when the field group is exposed to the REST API. */
  acf?: Record<string, unknown>;
  content?: { rendered?: string };
  /** The same field, when registered as a top-level REST field. */
  image_for_mobile_app?: unknown;
  /** Post meta registered with show_in_rest. */
  meta?: Record<string, unknown>;
  date_gmt?: string;
  excerpt?: { rendered?: string };
  id: number;
  link?: string;
  modified_gmt?: string;
  title?: { rendered?: string };
};

const listFields = "id,date_gmt,modified_gmt,link,title,content,_links,_embedded";
const youtubeIdCacheTtlMs = 24 * 60 * 60 * 1000;
// One decoder for the whole API, the one in lib/html-text.ts. This file kept
// a private six-entry map (amp, apos, gt, lt, nbsp, quot) and so left every
// other named entity on the page as text: a blog excerpt reached the app
// ending in a literal "[&hellip;]", and typographic dashes and quotes
// arrived as "&ndash;" and "&rsquo;". Re-exported so galaxy-content.ts and
// anything else importing it from here keeps working.
export { decodeEntities } from "../lib/html-text.js";
import { decodeEntities } from "../lib/html-text.js";

export function toText(html = ""): string {
  return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/**
 * An excerpt as a line of text. WordPress ends a generated excerpt with its
 * "more" marker, "[&hellip;]" by default, which is a link affordance on the
 * website and nothing but brackets in an app. It becomes a plain ellipsis.
 */
export function excerptText(html = ""): string {
  return toText(html).replace(/\s*\[(?:…|\.{3})\]\s*$/u, "…");
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

/**
 * The byline, from the author WordPress embeds alongside the featured image.
 * Null when the post type does not register an author, or the name is blank;
 * the app then credits the publication. Google Play's News policy asks that
 * every article show its author or source, which is why this travels at all.
 */
function authorName(post: WordPressPost): string | null {
  const name = post._embedded?.author?.[0]?.name;
  return typeof name === "string" && name.trim() ? toText(name) : null;
}

/**
 * The story's category, from the terms WordPress embeds with the post. A
 * story usually carries a catch-all ("News", "Uncategorized") beside the
 * one that says something ("Payments"); the first that says something
 * wins, and the catch-all only when it is all there is.
 */
const genericCategories = new Set(["news", "uncategorized", "uncategorised", "ibsi news"]);

function categoryName(post: WordPressPost): string | null {
  const categories = (post._embedded?.["wp:term"] ?? [])
    .flat()
    .filter((term) => term.taxonomy === "category" && typeof term.name === "string" && term.name.trim())
    .map((term) => toText(term.name as string));
  if (!categories.length) return null;
  return categories.find((name) => !genericCategories.has(name.toLowerCase())) ?? categories[0] ?? null;
}

/**
 * The guest author of a blog or opinion, from the post's own "By Jonathan
 * Frost, Director of Global Advisory at BioCatch" line.
 *
 * Not the WordPress author: that is the IBSi staffer who published the
 * piece. The site's convention puts the real author in the first paragraph
 * of the body, name then role after a comma, and that line is what readers
 * see on the website. Read from the body rather than the excerpt because
 * the excerpt flattens paragraphs and the role runs into the first
 * sentence. The first few lines only: a "By" further down is a quotation.
 */
function bylineFrom(post: WordPressPost): { author_name: string | null; author_role: string | null } {
  const lines = htmlToPlainText(post.content?.rendered ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
  for (const line of lines) {
    const match = /^by\s+([^,]{2,80}?)(?:,\s*(.{2,160}?))?\.?$/i.exec(line);
    if (match) {
      return { author_name: match[1]!.trim(), author_role: match[2]?.trim() || null };
    }
  }
  return { author_name: null, author_role: null };
}

/**
 * The image the editors upload for the app, "image_for_mobile_app" in
 * WordPress, as distinct from the featured image the website uses. Home's
 * Featured Intelligence card shows it; everything else keeps the featured
 * image.
 *
 * WordPress can expose a custom image field three ways, and which one the
 * site uses could not be checked from the development machine (Cloudflare
 * challenges every request that is not the API server's). So all three are
 * read, in order: a top-level REST field, an ACF field under `acf`, and
 * post meta under `meta`. Each may hold a URL, an ACF image object, or an
 * attachment id; an id costs one media lookup, cached like everything else.
 * Nothing found means null, and the app falls back to the featured image.
 */
const mobileImageField = "image_for_mobile_app";

function mobileImageCandidate(post: WordPressPost): string | number | null {
  const sources = [post.image_for_mobile_app, post.acf?.[mobileImageField], post.meta?.[mobileImageField]];
  for (const raw of sources) {
    if (raw === undefined || raw === null || raw === "" || raw === false) continue;
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
    if (typeof raw === "string") {
      const value = raw.trim();
      if (/^https?:\/\//i.test(value)) return value;
      if (/^\d+$/.test(value)) return Number(value);
      continue;
    }
    if (typeof raw === "object") {
      const image = raw as { url?: unknown; source_url?: unknown; sizes?: Record<string, unknown>; id?: unknown; ID?: unknown };
      const sized = image.sizes?.medium_large ?? image.sizes?.large;
      for (const candidate of [sized, image.url, image.source_url]) {
        if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return candidate;
      }
      const id = image.id ?? image.ID;
      if (typeof id === "number" && Number.isInteger(id) && id > 0) return id;
    }
  }
  return null;
}

async function mediaUrlById(id: number): Promise<string | null> {
  return cached(`wordpress:media:${id}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const url = new URL(`/wp-json/wp/v2/media/${id}`, config().WORDPRESS_BASE_URL);
    url.searchParams.set("_fields", "source_url,media_details");
    const response = await wordPressRequest(url, "application/json");
    const media = (await response.json()) as EmbeddedMedia;
    const sizes = media.media_details?.sizes;
    return sizes?.medium_large?.source_url ?? sizes?.large?.source_url ?? media.source_url ?? null;
  }).catch(() => null);
}

async function mobileImage(post: WordPressPost): Promise<string | null> {
  const candidate = mobileImageCandidate(post);
  if (candidate === null) return null;
  return typeof candidate === "number" ? mediaUrlById(candidate) : candidate;
}

/**
 * `expiresAt` is when an entry stops being fresh; `staleUntil` is when it
 * stops being servable at all. They are equal unless the caller asked for a
 * stale window.
 */
type CacheEntry<T> = { expiresAt: number; staleUntil: number; value: T };
const cache = new Map<string, CacheEntry<unknown>>();
/** One WordPress load per key at a time, however many readers ask at once. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * With `staleMs`, an expired entry is still answered at once for that long
 * while one fresh load runs in the background (stale-while-revalidate).
 * Without it, the first reader after expiry used to wait for WordPress -
 * about 3 seconds for the news list, measured on the live API 2026-10-16 -
 * which is the slow first screen the app's Home showed every 15 minutes.
 * A failed background load keeps the stale entry, so a WordPress outage
 * serves the last good list rather than an error.
 */
async function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  staleMs = 0
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    // Map iteration order is insertion order. Touching a hit makes the entry
    // most-recently-used so capacity eviction removes genuinely cold data.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value as T;
  }
  if (hit && hit.staleUntil > now) {
    cache.delete(key);
    cache.set(key, hit);
    refresh(key, ttlMs, load, staleMs).catch((error: unknown) =>
      console.error("[wordpress] background refresh failed", {
        key,
        error: error instanceof Error ? error.message : String(error)
      }));
    return hit.value as T;
  }
  if (hit) cache.delete(key);

  return refresh(key, ttlMs, load, staleMs);
}

function refresh<T>(key: string, ttlMs: number, load: () => Promise<T>, staleMs: number): Promise<T> {
  const running = inFlight.get(key);
  if (running) return running as Promise<T>;

  const loading = load()
    .then((value) => {
      store(key, value, ttlMs, staleMs);
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, loading);
  return loading;
}

function store<T>(key: string, value: T, ttlMs: number, staleMs: number): void {
  if (ttlMs <= 0) return;
  const insertionTime = Date.now();

  // Dead keys used to remain forever unless that exact key was requested
  // again. A public caller could therefore fill memory with unique searches.
  for (const [candidateKey, entry] of cache) {
    if (entry.staleUntil <= insertionTime) cache.delete(candidateKey);
  }

  cache.delete(key);
  const maximumEntries = config().MEDIA_CACHE_MAX_ENTRIES;
  while (cache.size >= maximumEntries) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }

  const expiresAt = insertionTime + ttlMs;
  cache.set(key, { expiresAt, staleUntil: expiresAt + staleMs, value });
}

/** Exposed for tests and for operational cache busting. */
export function clearMediaCache(): void {
  cache.clear();
}

async function wordPressRequest(
  url: URL,
  accept: string,
  options: { body?: string; contentType?: string; method?: "GET" | "POST" } = {}
): Promise<Response> {
  const env = config();
  const configuredOrigin = new URL(env.WORDPRESS_BASE_URL).origin;
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": env.WORDPRESS_USER_AGENT
  };
  if (options.contentType) headers["Content-Type"] = options.contentType;
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
        body: options.body,
        headers,
        method: options.method ?? "GET",
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
  url.searchParams.set("_embed", "wp:featuredmedia,author,wp:term");
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

const reportsCacheTtlMs = 60 * 60 * 1000;
const reportsFailureRetryMs = 5 * 60 * 1000;
let reportsCache: { refreshAfter: number; value: ResearchReportItem[] } | null = null;
let reportsLoad: Promise<ResearchReportItem[]> | null = null;

function publicImageUrl(value: string | undefined): string | null {
  if (!value) return null;
  const decoded = decodeEntities(value).trim();
  const candidate = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  try {
    const url = new URL(candidate, config().WORDPRESS_BASE_URL);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(tag);
  return match?.[2];
}

function reportImageFromCard(card: string): string | null {
  const imageTag = /<img\b[^>]*>/i.exec(card)?.[0];
  if (!imageTag) return null;

  const candidates = (attribute(imageTag, "srcset") ?? "")
    .split(",")
    .map((entry) => /^(.*?)\s+(\d+)w\s*$/.exec(entry.trim()))
    .filter((entry): entry is RegExpExecArray => entry !== null)
    .map((entry) => ({ url: entry[1], width: Number(entry[2]) }));
  const preferred = candidates.find((candidate) => candidate.width === 600)
    ?? candidates.filter((candidate) => candidate.width <= 800).sort((a, b) => b.width - a.width)[0]
    ?? candidates.sort((a, b) => a.width - b.width)[0];
  return publicImageUrl(preferred?.url ?? attribute(imageTag, "src"));
}

/** Parses the theme's report cards without depending on the rest of its layout. */
function reportsFromAjaxHtml(html: string): ResearchReportItem[] {
  const starts = [...html.matchAll(/class\s*=\s*["'][^"']*\bartHorBlo\b[^"']*["']/gi)].map((match) => match.index);
  const reports: ResearchReportItem[] = [];

  starts.forEach((start, index) => {
    const card = html.slice(start, starts[index + 1] ?? html.length);
    const titleHtml = /<h6\b[^>]*>([\s\S]*?)<\/h6>/i.exec(card)?.[1];
    const productLink = /<a\b[^>]*href\s*=\s*(["'])([^"']*\/product\/[^"']*)\1/i.exec(card)?.[2];
    const title = toText(titleHtml ?? "");
    if (!title || !productLink) return;

    try {
      const url = new URL(decodeEntities(productLink), config().WORDPRESS_BASE_URL);
      const parts = url.pathname.split("/").filter(Boolean);
      const productIndex = parts.lastIndexOf("product");
      const slug = parts[productIndex + 1];
      if (!slug) return;
      reports.push({ id: decodeURIComponent(slug), image_url: reportImageFromCard(card), title });
    } catch {
      // One malformed card must not discard the rest of the listing.
    }
  });
  return reports;
}

function ajaxHtml(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const candidate of [record.html, record.content, record.data, record.posts]) {
        if (typeof candidate === "string") return candidate;
        if (candidate && typeof candidate === "object") {
          const nested = candidate as Record<string, unknown>;
          if (typeof nested.html === "string") return nested.html;
          if (typeof nested.content === "string") return nested.content;
        }
      }
    }
  } catch {
    // The endpoint normally returns HTML directly rather than JSON.
  }
  return payload;
}

async function reportsFromAjax(): Promise<ResearchReportItem[]> {
  const reports: ResearchReportItem[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= 20; page += 1) {
    const body = new URLSearchParams({
      action: "get_research_items_by_category_for_listing",
      cat_slug: "0",
      pg_no: String(page),
      post_type: "POST",
      s: ""
    }).toString();
    const response = await wordPressRequest(
      new URL("/wp-admin/admin-ajax.php", config().WORDPRESS_BASE_URL),
      "text/html,application/json",
      { body, contentType: "application/x-www-form-urlencoded;charset=UTF-8", method: "POST" }
    );
    const pageReports = reportsFromAjaxHtml(ajaxHtml(await response.text()));
    if (pageReports.length === 0) break;
    for (const report of pageReports) {
      const key = String(report.id);
      if (!seen.has(key)) {
        seen.add(key);
        reports.push(report);
      }
    }
  }
  return reports;
}

async function loadResearchReports(): Promise<ResearchReportItem[]> {
  // WordPress exposes `product`, but that collection also contains Journal
  // subscriptions and event tickets (78 products on 2026-10-15) and its REST
  // order differs from /reports-view-all/. The theme's AJAX action is the
  // only source that applies the report-only scope and editorial ordering.
  return reportsFromAjax();
}

/** One-hour fresh cache; a last good list remains usable during WordPress failures. */
export async function listResearchReports(): Promise<ResearchReportItem[]> {
  const now = Date.now();
  if (reportsCache && reportsCache.refreshAfter > now) return reportsCache.value;
  if (reportsLoad) return reportsLoad;

  reportsLoad = loadResearchReports()
    .then((value) => {
      reportsCache = { refreshAfter: Date.now() + reportsCacheTtlMs, value };
      return value;
    })
    .catch(() => {
      if (reportsCache) {
        reportsCache.refreshAfter = Date.now() + reportsFailureRetryMs;
        return reportsCache.value;
      }
      reportsCache = { refreshAfter: Date.now() + reportsFailureRetryMs, value: [] };
      return [];
    })
    .finally(() => {
      reportsLoad = null;
    });
  return reportsLoad;
}

const reportDetailCacheTtlMs = 5 * 60 * 1000;
const reportSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const reportSectionDefinitions = [
  { key: "highlights", labels: ["report highlights", "highlights"], title: "Report highlights" },
  { key: "benefits", labels: ["why subscribe?", "why subscribe", "benefits"], title: "Why subscribe?" },
  {
    key: "audience",
    labels: ["who finds this report useful?", "who finds this report useful", "intended audience"],
    title: "Who finds this report useful?"
  },
  { key: "contents", labels: ["table of contents", "contents"], title: "Table of Contents" }
] as const;

function normalizedLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Allow useful editorial markup only; all styling and active content is discarded. */
function cleanReportHtml(fragment: string | null | undefined): string | null {
  if (!fragment?.trim()) return null;
  const $ = load(`<div id="report-fragment">${fragment}</div>`, null, false);
  const root = $("#report-fragment");
  root.find("script,style,form,nav,header,footer,iframe,object,embed,input,button,select,textarea,img,svg").remove();
  root.find("a").each((_index, element) => {
    $(element).replaceWith($(element).contents());
  });

  const allowed = new Set([
    "p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "u", "blockquote",
    "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td"
  ]);
  root.find("*").each((_index, element) => {
    const node = $(element);
    if (element.tagName === "div" || element.tagName === "span" || element.tagName === "section") {
      node.replaceWith(node.contents());
    } else if (!allowed.has(element.tagName)) {
      node.replaceWith(node.contents());
    } else {
      for (const attributeName of Object.keys(element.attribs ?? {})) node.removeAttr(attributeName);
    }
  });

  const html = root.html()?.replace(/(?:\s*<br>\s*){3,}/gi, "<br><br>").trim() ?? "";
  return toText(html) ? html : null;
}

function reportSectionHtml($: ReturnType<typeof load>, marker: ReturnType<ReturnType<typeof load>>): string | null {
  const target = marker.attr("data-bs-target") ?? marker.attr("data-target") ?? marker.attr("href");
  if (target?.startsWith("#") && /^#[A-Za-z][\w:.-]*$/.test(target)) {
    const targeted = $(target).first();
    if (targeted.length) {
      const body = targeted.find(".accordion-body,.card-body,.tab-pane").first();
      const cleaned = cleanReportHtml((body.length ? body : targeted).html());
      if (cleaned) return cleaned;
    }
  }

  const item = marker.closest(".accordion-item,.card,.vc_tta-panel,.elementor-accordion-item");
  if (item.length) {
    const body = item.find(".accordion-body,.card-body,.vc_tta-panel-body,.elementor-tab-content,.collapse").first();
    const cleaned = cleanReportHtml(body.html());
    if (cleaned) return cleaned;
  }

  for (const candidate of [marker.next(), marker.parent().next(), marker.parent().children().not(marker)]) {
    const cleaned = cleanReportHtml(candidate.first().html());
    if (cleaned) return cleaned;
  }
  return null;
}

function reportDetailFromHtml(item: ResearchReportItem, html: string): ResearchReportDetail {
  const $ = load(html);
  $("script,style,form,nav,header,footer,iframe,object,embed").remove();
  const title = toText($("h1.product_title,h1.entry-title,h1").first().html() ?? "") || item.title;
  const productRoot = $(".product.type-product,.single-product,main").first();
  const rootText = (productRoot.length ? productRoot : $("body")).text().replace(/\s+/g, " ");
  const pages = /\b(\d{1,4})\s+pages?\b/i.exec(rootText);
  const parsedPageCount = pages ? Number(pages[1]) : null;
  const pageCount = parsedPageCount && parsedPageCount > 0 ? parsedPageCount : null;

  let descriptionHtml = cleanReportHtml($(".woocommerce-product-details__short-description").first().html());
  if (!descriptionHtml) {
    const titleNode = $("h1.product_title,h1.entry-title,h1").first();
    const pieces: string[] = [];
    titleNode.nextAll().each((_index, element) => {
      const node = $(element);
      const text = normalizedLabel(node.text());
      if (reportSectionDefinitions.some((section) => section.labels.includes(text as never))) return false;
      if (/related reports|share report|buy now|questions about this report/i.test(text)) return false;
      pieces.push(node.toString());
    });
    descriptionHtml = cleanReportHtml(pieces.join(""));
  }

  const sections: ResearchReportSection[] = [];
  const used = new Set<string>();
  $("button,h2,h3,h4,h5,h6,a,[role='button']").each((_index, element) => {
    const marker = $(element);
    const label = normalizedLabel(marker.text());
    const definition = reportSectionDefinitions.find((section) => section.labels.includes(label as never));
    if (!definition || used.has(definition.key)) return;
    const contentHtml = reportSectionHtml($, marker);
    if (!contentHtml) return;
    used.add(definition.key);
    sections.push({ content_html: contentHtml, key: definition.key, title: definition.title });
  });

  const pageImage = publicImageUrl(
    $(".woocommerce-product-gallery__image img").first().attr("data-large_image")
      ?? $("meta[property='og:image']").attr("content")
  );
  return {
    description_html: descriptionHtml,
    id: item.id,
    image_url: pageImage ?? item.image_url,
    page_count: pageCount,
    sections,
    title
  };
}

/** Public report copy from its live WooCommerce product page. */
export async function getResearchReport(reportId: string): Promise<ResearchReportDetail | null> {
  if (!reportSlugPattern.test(reportId)) return null;
  const catalogue = await listResearchReports();
  const item = catalogue.find((report) => String(report.id) === reportId);
  if (!item) return null;

  return cached(`research-report-detail:v1:${reportId}`, reportDetailCacheTtlMs, async () => {
    const url = new URL(`/product/${encodeURIComponent(reportId)}/`, config().WORDPRESS_BASE_URL);
    const response = await wordPressRequest(url, "text/html");
    return reportDetailFromHtml(item, await response.text());
  });
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
  /** The byline; null when WordPress has none for the post. */
  author_name: string | null;
  /** The story's category ("Payments"); null when the post has none. */
  category_name: string | null;
  excerpt: string | null;
  id: number;
  image_url: string | null;
  /** The editors' app image (image_for_mobile_app); null when none is set. */
  mobile_image_url: string | null;
  link: string;
  published_at: string | null;
  title: string;
};

export type NewsCategoryItem = {
  count: number;
  id: number;
  name: string;
};

/** Stable Home-card shape shared by every content type we add later. */
export type HomeFeaturedItem = {
  content_id: string;
  content_type: string;
  /** Journal cards only: which edition the issue belongs to, for the app's switcher. */
  edition?: "india" | "global" | null;
  excerpt: string | null;
  image_url: string | null;
  link: string;
  published_at: string | null;
  title: string;
};

type HomeFeaturedSource = {
  contentType: string;
  postTypeRestBase: string;
};

/**
 * The carousel's WordPress sources, in the order the cards appear: blogs,
 * leadership interviews, case studies, then news. The Journal card is added
 * by the route from Postgres. Each source yields at most one card, the
 * newest post carrying the term.
 */
const homeFeaturedSources: HomeFeaturedSource[] = [
  { contentType: "blog", postTypeRestBase: "blogs" },
  { contentType: "leadership_interview", postTypeRestBase: "leadership-interview" },
  { contentType: "case_study", postTypeRestBase: "casestudy" },
  { contentType: "news", postTypeRestBase: "ibsi_news" }
];

const homeFeaturedTaxonomyRestBase = "editor_s_picks";
/**
 * The term the editors tick on a story to put it at the top of Home. Named
 * "FinTech Focus" in WordPress (term 45246), confirmed by the site's
 * developer on 2026-10-09; the slug, not the name, is what the lookup sends.
 */
const homeFeaturedTermSlug = "fintech-focus";

/**
 * The feed omits article bodies: including them nearly doubles the page to
 * carry text the list never renders. Bodies are served by getArticleBody.
 */
// `acf`, `meta` and the bare field name: see mobileImageCandidate. Asking
// for a field the site does not expose costs nothing - WordPress omits it.
const newsListFields = "id,date_gmt,link,title,excerpt,_links,_embedded,acf,meta,image_for_mobile_app";

async function taxonomyTermId(taxonomyRestBase: string, slug: string): Promise<number | null> {
  return cached(
    `wordpress:taxonomy-term:${taxonomyRestBase}:${slug}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const url = new URL(`/wp-json/wp/v2/${taxonomyRestBase}`, config().WORDPRESS_BASE_URL);
      url.searchParams.set("slug", slug);
      url.searchParams.set("per_page", "1");
      url.searchParams.set("_fields", "id,slug");
      const response = await wordPressRequest(url, "application/json");
      const terms = (await response.json()) as Array<{ id?: number; slug?: string }>;
      const id = Array.isArray(terms) ? terms[0]?.id : undefined;
      return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
    }
  );
}

/**
 * Builds one card per configured source, skipping a source that has no post
 * carrying the term.
 *
 * The guard on the term matters. WordPress ignores a taxonomy filter on a
 * post type the taxonomy is not registered for, and answers with that type's
 * newest post as if no filter had been asked. Without the check, attaching
 * the taxonomy to news alone would put an arbitrary latest blog, interview
 * and case study in the carousel as "featured". So the term ids are asked
 * for on the post and the card is only built when the term is really there.
 */
async function listHomeFeaturedSources(
  sources: HomeFeaturedSource[],
  taxonomyRestBase: string,
  termSlug: string
): Promise<HomeFeaturedItem[]> {
  const termId = await taxonomyTermId(taxonomyRestBase, termSlug);
  if (!termId) return [];

  const results: HomeFeaturedItem[] = [];
  // Sequential by design: WordPress/Cloudflare is less reliable under bursts,
  // and this is cached so only a cold request pays for the source lookups.
  for (const source of sources) {
    const { posts } = await fetchPostType(source.postTypeRestBase, 1, 1, {
      fields: `${newsListFields},${taxonomyRestBase}`,
      params: { [taxonomyRestBase]: String(termId) }
    });
    const post = posts[0];
    if (!post) continue;
    const terms = (post as Record<string, unknown>)[taxonomyRestBase];
    if (!Array.isArray(terms) || !terms.includes(termId)) continue;
    results.push({
      content_id: String(post.id),
      content_type: source.contentType,
      excerpt: excerptText(post.excerpt?.rendered) || null,
      image_url: featuredImage(post),
      link: post.link ?? "",
      published_at: toIsoTimestamp(post.date_gmt),
      title: toText(post.title?.rendered)
    });
  }
  return results;
}

/**
 * The editor-selected WordPress cards for the Home carousel, at most one per
 * source in `homeFeaturedSources`. The route appends the Journal card.
 */
export async function listHomeFeatured(): Promise<HomeFeaturedItem[]> {
  // Include the editorial selector in the key. A warm Azure worker may retain
  // its in-memory cache across a package swap, and reusing a generic key here
  // kept the empty result from the former `featured-news` lookup alive after
  // editors confirmed the real term was `fintech-focus`. v2: four sources.
  return cached(`home:featured:v2:${homeFeaturedTermSlug}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, () =>
    listHomeFeaturedSources(homeFeaturedSources, homeFeaturedTaxonomyRestBase, homeFeaturedTermSlug)
  );
}

/** Start of a rolling content window, as WordPress-compatible ISO 8601. */
function contentWindowStart(months: number): string {
  const start = new Date();
  start.setMonth(start.getMonth() - months);
  return start.toISOString().slice(0, 19);
}

/**
 * How long an expired news list may still be answered while a fresh one
 * loads behind it. A day covers a quiet night; past that the reader waits
 * for WordPress rather than seeing a day-old front page.
 */
const newsListStaleMs = 24 * 60 * 60 * 1000;

export async function listNews(
  page: number,
  limit: number,
  categoryId?: number,
  regionSlug?: string
): Promise<MediaPage<NewsItem>> {
  const months = config().NEWS_WINDOW_MONTHS;
  const region = findNewsRegion(regionSlug);
  // v2 adds category_name to the cached response shape. Azure can keep a
  // warm worker's in-memory cache across a package swap, so reusing the old
  // key would serve category-less items until that entry expires.
  const key = `news:v2:${page}:${limit}:${categoryId ?? "all"}:${region?.slug ?? "all"}`;

  return cached(key, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const params: Record<string, string> = { after: contentWindowStart(months) };
    if (categoryId) params.categories = String(categoryId);
    // Comma-separated tag ids are OR in the WordPress REST API, which is what
    // a region needs: any one of its spellings counts as a match.
    if (region) params.tags = newsRegionTagParam(region);

    const { posts, total } = await fetchPostType("ibsi_news", page, limit, {
      fields: newsListFields,
      params
    });

    // One at a time, not Promise.all: a mobile image held as an attachment
    // id costs a media lookup, and a burst of those is what Cloudflare drops.
    const items: NewsItem[] = [];
    for (const post of posts) {
      items.push({
        author_name: authorName(post),
        category_name: categoryName(post),
        excerpt: excerptText(post.excerpt?.rendered) || null,
        id: post.id,
        image_url: featuredImage(post),
        link: post.link ?? "",
        mobile_image_url: await mobileImage(post),
        published_at: toIsoTimestamp(post.date_gmt),
        title: toText(post.title?.rendered)
      });
    }

    return { items, total };
  }, newsListStaleMs);
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
  const key = `news:search:v2:${query.toLowerCase()}:${page}:${limit}:${categoryId ?? "all"}:${region?.slug ?? "all"}`;

  return cached(key, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const params: Record<string, string> = { orderby: "relevance", search: query };
    if (categoryId) params.categories = String(categoryId);
    if (region) params.tags = newsRegionTagParam(region);

    const { posts, total } = await fetchPostType("ibsi_news", page, limit, {
      fields: newsListFields,
      params
    });

    // One at a time, not Promise.all: a mobile image held as an attachment
    // id costs a media lookup, and a burst of those is what Cloudflare drops.
    const items: NewsItem[] = [];
    for (const post of posts) {
      items.push({
        author_name: authorName(post),
        category_name: categoryName(post),
        excerpt: excerptText(post.excerpt?.rendered) || null,
        id: post.id,
        image_url: featuredImage(post),
        link: post.link ?? "",
        mobile_image_url: await mobileImage(post),
        published_at: toIsoTimestamp(post.date_gmt),
        title: toText(post.title?.rendered)
      });
    }

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
    const after = contentWindowStart(config().NEWS_WINDOW_MONTHS);
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
export type ArticleContent = { author_name: string | null; html: string | null; text: string | null };

export type PerspectiveArticleContent = ArticleContent & {
  image_url: string | null;
  link: string;
  title: string;
};
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

function newsSlugFromArticleId(articleId: string): string | null {
  return articleId.startsWith("slug:") ? articleId.slice("slug:".length).trim() || null : null;
}

export function newsSlugFromLink(link: string): string | null {
  try {
    const parsed = new URL(link);
    const slug = parsed.pathname.split("/").filter(Boolean).at(-1);
    return slug ?? null;
  } catch {
    return null;
  }
}

async function getNewsPostByArticleId(articleId: string, fields: string): Promise<WordPressPost | null> {
  const slug = newsSlugFromArticleId(articleId);

  if (slug) {
    const url = new URL("/wp-json/wp/v2/ibsi_news", config().WORDPRESS_BASE_URL);
    url.searchParams.set("slug", slug);
    url.searchParams.set("_embed", "wp:featuredmedia,author,wp:term");
    url.searchParams.set("_fields", fields);

    const response = await wordPressRequest(url, "application/json");
    const posts = (await response.json()) as WordPressPost[];
    return Array.isArray(posts) ? posts[0] ?? null : null;
  }

  const url = new URL(
    `/wp-json/wp/v2/ibsi_news/${encodeURIComponent(wordPressArticleId(articleId))}`,
    config().WORDPRESS_BASE_URL
  );
  url.searchParams.set("_embed", "wp:featuredmedia,author,wp:term");
  url.searchParams.set("_fields", fields);

  const response = await wordPressRequest(url, "application/json");
  return (await response.json()) as WordPressPost;
}

export async function resolveNewsArticleIdFromLink(link: string): Promise<string | null> {
  const slug = newsSlugFromLink(link);
  if (!slug) return null;

  return cached(`news:article-id-by-slug:${slug}`, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const post = await getNewsPostByArticleId(`slug:${slug}`, "id");
    return post?.id ? String(post.id) : null;
  });
}

/** Resolves notification copy and artwork from the canonical WordPress post. */
export async function getArticleMetadata(articleId: string): Promise<ArticleMetadata | null> {
  return cached(
    `news:article-metadata:${articleId}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const post = await getNewsPostByArticleId(articleId, "id,title,_links,_embedded");
      if (!post) return null;
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
  // v3: carries the byline, so a warm worker's v2 entries are not reused.
  return cached(
    `news:article:v3:${articleId}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const post = await getNewsPostByArticleId(articleId, "id,content,_links,_embedded");
      if (!post) return null;
      const html = post.content?.rendered ?? null;
      const text = htmlToPlainText(post.content?.rendered) || null;

      return text || html ? { author_name: authorName(post), html, text } : null;
    }
  );
}

/**
 * A curated Perspective can point at any editorial WordPress post type, not
 * only `ibsi_news`. Resolve its canonical permalink slug across the post types
 * the API already supports and return one common native-reader shape.
 */
export async function getPerspectiveArticleContent(link: string): Promise<PerspectiveArticleContent | null> {
  const slug = newsSlugFromLink(link);
  if (!slug) return null;

  return cached(
    `perspective-article:v1:${slug}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const restBases = ["posts", "pages", "blogs", "articles", "ibsi_news", "leadership-interview", "casestudy"];

      for (const restBase of restBases) {
        const url = new URL(`/wp-json/wp/v2/${restBase}`, config().WORDPRESS_BASE_URL);
        url.searchParams.set("slug", slug);
        url.searchParams.set("per_page", "1");
        url.searchParams.set("_embed", "wp:featuredmedia,author,wp:term");
        url.searchParams.set("_fields", "id,link,title,content,_links,_embedded");

        let response: Response;
        try {
          response = await wordPressRequest(url, "application/json");
        } catch (error) {
          // The site deliberately disables some standard REST collections
          // while leaving its custom editorial collections available. One
          // restricted type must not prevent trying the remaining types.
          if (error instanceof HttpError && /returned (403|404) /.test(error.message)) continue;
          throw error;
        }
        const posts = (await response.json()) as WordPressPost[];
        const post = Array.isArray(posts) ? posts[0] : undefined;
        if (!post?.id) continue;

        const html = post.content?.rendered ?? null;
        const text = htmlToPlainText(html ?? "") || null;
        if (!text && !html) return null;

        return {
          author_name: authorName(post),
          html,
          image_url: featuredImage(post),
          link: post.link ?? link,
          text,
          title: toText(post.title?.rendered)
        };
      }

      return null;
    }
  );
}

/** Fetches a database-curated WordPress image through the API's WAF access. */
export async function getWordPressImage(imageUrl: string): Promise<{ body: Buffer; contentType: string }> {
  const response = await wordPressRequest(new URL(imageUrl), "image/*");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/")) {
    throw new HttpError(502, "WordPress returned a non-image asset", "WORDPRESS_UNAVAILABLE");
  }

  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredSize) && declaredSize > 10 * 1024 * 1024) {
    throw new HttpError(502, "WordPress image is too large", "WORDPRESS_UNAVAILABLE");
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 10 * 1024 * 1024) {
    throw new HttpError(502, "WordPress image is too large", "WORDPRESS_UNAVAILABLE");
  }
  return { body, contentType };
}

export async function getArticleBody(articleId: string): Promise<string | null> {
  return (await getArticleContent(articleId))?.text ?? null;
}

/** `categoryId` narrows to one WordPress category, as on the editorial listers. */
export async function listPodcasts(
  page: number,
  limit: number,
  categoryId?: number
): Promise<MediaPage<PodcastItem>> {
  const key = `podcasts:${page}:${limit}:${categoryId ?? "all"}`;
  return cached(key, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const { posts, total } = await fetchPostType("podcasts", page, limit, {
      params: categoryId ? { categories: String(categoryId) } : undefined
    });
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
export async function listVideos(
  page: number,
  limit: number,
  categoryId?: number
): Promise<MediaPage<VideoItem>> {
  const key = `videos:${page}:${limit}:${categoryId ?? "all"}`;
  return cached(key, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const { posts, total } = await fetchPostType("videos", page, limit, {
      params: categoryId ? { categories: String(categoryId) } : undefined
    });
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
  url.searchParams.set("_embed", "wp:featuredmedia,author,wp:term");
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

export async function listWebinars(
  page: number,
  limit: number,
  categoryId?: number
): Promise<MediaPage<VideoItem>> {
  const key = `webinars:${page}:${limit}:${categoryId ?? "all"}`;
  return cached(key, config().MEDIA_CACHE_TTL_SECONDS * 1000, async () => {
    const { posts, total } = await fetchPostType("webinars", page, limit, {
      params: categoryId ? { categories: String(categoryId) } : undefined
    });
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
  /** Optional rolling listing window. Detail links remain addressable by id. */
  listWindowMonths?: number;
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

const blogPostType: EditorialPostType = {
  cachePrefix: "blog",
  listWindowMonths: 6,
  restBase: "blogs"
};

const caseStudyPostType: EditorialPostType = {
  cachePrefix: "case-study",
  // WordPress registers the post type under the singular `casestudy` base;
  // `/case-studies/` is only the public archive page URL.
  restBase: "casestudy"
};

/**
 * `categoryId` narrows the listing to posts in that WordPress category -
 * the site's own topic filter, see lib/insight-topics.ts; the topics are
 * categories, the same ones the news feed filters by. Part of the cache
 * key, so a filtered page never stands in for the whole.
 */
async function listEditorialPosts(
  type: EditorialPostType,
  page: number,
  limit: number,
  categoryId?: number
): Promise<MediaPage<AnalystOpinionItem>> {
  return cached(
    // v2 adds author_name and author_role to the cached list shape.
    `${type.cachePrefix}s:v2:${page}:${limit}:${categoryId ?? "all"}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const params: Record<string, string> = {};
      if (type.listWindowMonths) params.after = contentWindowStart(type.listWindowMonths);
      if (categoryId) params.categories = String(categoryId);
      // `content` is asked for only to read the "By …" line off its first
      // paragraph (bylineFrom); the list never sends bodies to the app.
      const { posts, total } = await fetchPostType(type.restBase, page, limit, {
        fields: "id,date_gmt,link,title,excerpt,content,_links,_embedded",
        params
      });
      return {
        items: posts.map((post) => ({
          ...bylineFrom(post),
          excerpt: excerptText(post.excerpt?.rendered) || null,
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
    // v2 adds author_name and author_role to the cached detail shape.
    `${type.cachePrefix}:v2:${wordpressId}`,
    config().MEDIA_CACHE_TTL_SECONDS * 1000,
    async () => {
      const url = new URL(
        `/wp-json/wp/v2/${type.restBase}/${encodeURIComponent(wordpressId)}`,
        config().WORDPRESS_BASE_URL
      );
      url.searchParams.set("_embed", "wp:featuredmedia,author,wp:term");
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
        ...bylineFrom(post),
        body,
        body_html: bodyHtml,
        excerpt: excerptText(post.excerpt?.rendered) || null,
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
  limit: number,
  categoryId?: number
): Promise<MediaPage<AnalystOpinionItem>> {
  return listEditorialPosts(analystOpinionPostType, page, limit, categoryId);
}

/**
 * The Analyst Opinions topic buttons are editorial website configuration, not
 * an app-owned taxonomy. Read them from /views/ so adding, removing or
 * reordering a button does not require an API or app release.
 */
export async function listAnalystOpinionTopics(): Promise<InsightTopic[]> {
  return cached("analyst-opinion-topics", config().MEDIA_CACHE_TTL_SECONDS * 12_000, async () => {
    const response = await wordPressRequest(
      new URL("/views/", config().WORDPRESS_BASE_URL),
      "text/html"
    );
    const html = await response.text();
    const topics = new Map<number, InsightTopic>();
    const elementPattern =
      /<([a-z][\w-]*)\b([^>]*\bclass=["'][^"']*\bbtn-cat\b[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/gi;

    for (const match of html.matchAll(elementPattern)) {
      const attributes = match[2] ?? "";
      const id = Number(/\battr-tid=["'](\d+)["']/i.exec(attributes)?.[1]);
      const name = toText(match[3] ?? "");
      if (!Number.isInteger(id) || id <= 0 || !name || /^(?:all|webinars)$/i.test(name)) continue;
      topics.set(id, { id, name });
    }

    if (topics.size === 0) {
      throw new HttpError(502, "WordPress returned no Insight topics", "WORDPRESS_UNAVAILABLE");
    }
    return [...topics.values()];
  });
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
  limit: number,
  categoryId?: number
): Promise<MediaPage<LeadershipInterviewItem>> {
  return listEditorialPosts(leadershipInterviewPostType, page, limit, categoryId);
}

export async function getLeadershipInterview(
  interviewId: string
): Promise<LeadershipInterviewDetail | null> {
  return getEditorialPost(leadershipInterviewPostType, interviewId);
}

/**
 * Blogs are free editorial posts under the site's `/blogs/` section. The list
 * is limited at WordPress to the rolling last six months; detail links remain
 * addressable by id. Neither list nor body is metered.
 */
export async function listBlogs(
  page: number,
  limit: number,
  categoryId?: number
): Promise<MediaPage<BlogItem>> {
  return listEditorialPosts(blogPostType, page, limit, categoryId);
}

export async function getBlog(blogId: string): Promise<BlogDetail | null> {
  return getEditorialPost(blogPostType, blogId);
}

/**
 * Case Studies are premium Insights content. The listing is public, while the
 * detail body is served only after the shared Insights meter grants access.
 */
export async function listCaseStudies(
  page: number,
  limit: number,
  categoryId?: number
): Promise<MediaPage<CaseStudyItem>> {
  return listEditorialPosts(caseStudyPostType, page, limit, categoryId);
}

/** A site topic with how many items of one kind it holds. */
export type ContentTopic = InsightTopic & { count: number };

/**
 * The site's topics that actually narrow one kind of content, each with its
 * count. The site offers the same topic buttons on every Views page, but a
 * topic with no podcasts is a chip that leads to an empty list, and a post
 * type that ignores `categories` altogether would redraw the same list under
 * every chip. So each topic is counted against the kind, one request each
 * (sequentially - a burst trips the site's bot protection), and kept only
 * when it holds something and fewer than everything. If no topic differs
 * from the whole, the filter is not honoured for this kind and the list is
 * empty, which the app reads as "no filter here". Cached for twelve hours.
 */
/**
 * The topic lists are the slowest thing this file computes: one WordPress
 * request per site topic, twenty-odd of them, one after another so
 * Cloudflare does not drop the burst. Cold, that is longer than the app
 * waits for an answer (15 s), and on 2026-10-14 the Leadership Interviews
 * screen logged exactly that: "[topics] failed ... AbortError" on the first
 * open after the three-hour cache had lapsed, and nothing wrong on the
 * next. So the app is never made to wait on the count: once a kind has
 * been counted, the last answer is served at once when the cache lapses
 * and the recount runs behind it. The only cold path left is a process
 * that has never counted, which warmContentTopics() covers at start-up.
 */
const lastKnownTopics = new Map<string, ContentTopic[]>();
const topicsRefreshing = new Set<string>();

async function countTopics(
  countFor: (categoryId?: number) => Promise<number>
): Promise<ContentTopic[]> {
  const all = await countFor();
  if (all === 0) return [];
  const counted: ContentTopic[] = [];
  for (const topic of await listAnalystOpinionTopics()) {
    counted.push({ ...topic, count: await countFor(topic.id) });
  }
  if (counted.every((topic) => topic.count === all)) return [];
  return counted.filter((topic) => topic.count > 0 && topic.count < all);
}

async function listTopicsFor(
  kind: string,
  countFor: (categoryId?: number) => Promise<number>
): Promise<ContentTopic[]> {
  const key = `topics:${kind}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as ContentTopic[];

  const recount = () =>
    cached(key, config().MEDIA_CACHE_TTL_SECONDS * 12_000, async () => {
      const topics = await countTopics(countFor);
      lastKnownTopics.set(kind, topics);
      return topics;
    });

  const stale = lastKnownTopics.get(kind);
  if (!stale) return recount();

  if (!topicsRefreshing.has(kind)) {
    topicsRefreshing.add(kind);
    recount()
      .catch(() => undefined)
      .finally(() => topicsRefreshing.delete(kind));
  }
  return stale;
}

export const listPodcastTopics = () =>
  listTopicsFor("podcasts", async (categoryId) => (await listPodcasts(1, 1, categoryId)).total);
export const listVideoTopics = () =>
  listTopicsFor("videos", async (categoryId) => (await listVideos(1, 1, categoryId)).total);
export const listWebinarTopics = () =>
  listTopicsFor("webinars", async (categoryId) => (await listWebinars(1, 1, categoryId)).total);
export const listBlogTopics = () =>
  listTopicsFor("blogs", async (categoryId) => (await listBlogs(1, 1, categoryId)).total);
export const listCaseStudyTopics = () =>
  listTopicsFor("case-studies", async (categoryId) => (await listCaseStudies(1, 1, categoryId)).total);
export const listLeadershipInterviewTopics = () =>
  listTopicsFor(
    "leadership-interviews",
    async (categoryId) => (await listLeadershipInterviews(1, 1, categoryId)).total
  );

/**
 * Counts every kind's topics once, at start-up, so no reader's first open
 * of a screen is the one that pays for the count. Sequential, and each
 * kind's failure is its own: WordPress being slow for one list must not
 * stop the others warming. Fire-and-forget from server.ts.
 */
export async function warmContentTopics(): Promise<void> {
  const warmers = [
    listAnalystOpinionTopics,
    listLeadershipInterviewTopics,
    listCaseStudyTopics,
    listBlogTopics,
    listPodcastTopics,
    listVideoTopics,
    listWebinarTopics
  ];
  for (const warm of warmers) {
    await warm().catch(() => undefined);
  }
}

export async function getCaseStudy(caseStudyId: string): Promise<CaseStudyDetail | null> {
  return getEditorialPost(caseStudyPostType, caseStudyId);
}
