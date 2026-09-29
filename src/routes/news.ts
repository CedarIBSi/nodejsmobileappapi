import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { newsRegionSlugs } from "../lib/news-regions.js";
import {
  getArticleContent,
  listNews,
  listNewsCategories,
  listNewsRegions,
  searchNews
} from "../services/wordpress.js";

export const newsRouter = Router();

const articleSchema = z.object({ news_article_id: z.string().trim().min(1).max(255) });
const articleParams = z.object({ news_article_id: z.string().trim().min(1).max(255) });
const newsListSchema = paginationSchema.extend({
  category: z.coerce.number().int().positive().optional(),
  // An enum, so an unrecognised slug is a 400 rather than a silent pass. A
  // region the server does not know would otherwise return unfiltered global
  // news, which the app would then display under that region's heading - the
  // one failure here that a reader cannot see and would not think to doubt.
  region: z.enum(newsRegionSlugs).optional()
});
const newsSearchSchema = newsListSchema.extend({
  // Two characters is the shortest useful term; the cap keeps a pathological
  // query out of the cache key.
  q: z.string().trim().min(2).max(120)
});

/**
 * Public, cacheable reads. These carry Cache-Control so Cloudflare can serve
 * them from the edge; without it every app open reaches WordPress, which does
 * not survive app-scale traffic.
 */
const publicCacheSeconds = 300;

newsRouter.get("/", validate(newsListSchema, "query"), asyncHandler(async (req, res) => {
  const { category, limit, page, region } = req.query as unknown as {
    category?: number;
    limit: number;
    page: number;
    region?: string;
  };
  const { items, total } = await listNews(page, limit, category, region);
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ articles: items, pagination: pagination(page, limit, total) });
}));

newsRouter.get("/search", validate(newsSearchSchema, "query"), asyncHandler(async (req, res) => {
  const { category, limit, page, q, region } = req.query as unknown as {
    category?: number;
    limit: number;
    page: number;
    q: string;
    region?: string;
  };
  const { items, total } = await searchNews(q, page, limit, category, region);
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ articles: items, pagination: pagination(page, limit, total) });
}));

newsRouter.get("/regions", asyncHandler(async (_req, res) => {
  const regions = await listNewsRegions();
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ regions });
}));

newsRouter.get("/categories", asyncHandler(async (_req, res) => {
  const categories = await listNewsCategories();
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ categories });
}));

// News is free. The body used to sit behind the five-article meter, enforced
// here as well as in the app; that meter now lives on the Insights content
// (see src/lib/insight-meter.ts) and every article body is served to every
// caller. Public and edge-cached for the same reason the listings are.
newsRouter.get(
  "/articles/:news_article_id",
  validate(articleParams, "params"),
  asyncHandler(async (req, res) => {
    const { news_article_id: articleId } = req.params as { news_article_id: string };
    const content = await getArticleContent(articleId);

    if (content === null || content.text === null) {
      throw new HttpError(404, "Article not found", "ARTICLE_NOT_FOUND");
    }

    res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
    // `body` stays the flattened text every shipped build reads; `body_html`
    // is additive, for clients that can render the real markup.
    res.json({
      article: { body: content.text, body_html: content.html, id: articleId }
    });
  })
);

newsRouter.post("/reading-history", ...privateRoute, validate(articleSchema), asyncHandler(async (req, res) => {
  const result = await query(
    `INSERT INTO news_reading_history (user_id, news_article_id) VALUES ($1, $2)
     ON CONFLICT (user_id, news_article_id) DO UPDATE SET read_at = now()
     RETURNING id, news_article_id, read_at`,
    [req.appUser!.id, req.body.news_article_id]
  );
  res.json({ reading_history: result.rows[0] });
}));

newsRouter.get("/reading-history", ...privateRoute, validate(paginationSchema, "query"), asyncHandler(async (req, res) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };
  const [items, count] = await Promise.all([
    query("SELECT id, news_article_id, read_at FROM news_reading_history WHERE user_id = $1 ORDER BY read_at DESC LIMIT $2 OFFSET $3", [req.appUser!.id, limit, (page - 1) * limit]),
    query<{ count: string }>("SELECT count(*) FROM news_reading_history WHERE user_id = $1", [req.appUser!.id])
  ]);
  const total = Number(count.rows[0]?.count ?? 0);
  res.json({ items: items.rows, pagination: pagination(page, limit, total) });
}));

newsRouter.post("/saved-articles", ...privateRoute, validate(articleSchema), asyncHandler(async (req, res) => {
  const result = await query(
    `INSERT INTO saved_news_articles (user_id, news_article_id) VALUES ($1, $2)
     ON CONFLICT (user_id, news_article_id) DO UPDATE SET news_article_id = EXCLUDED.news_article_id
     RETURNING id, news_article_id, created_at`,
    [req.appUser!.id, req.body.news_article_id]
  );
  res.status(201).json({ saved_article: result.rows[0] });
}));

newsRouter.delete("/saved-articles/:news_article_id", ...privateRoute, validate(articleParams, "params"), asyncHandler(async (req, res) => {
  await query("DELETE FROM saved_news_articles WHERE user_id = $1 AND news_article_id = $2", [req.appUser!.id, req.params.news_article_id]);
  res.status(204).send();
}));

newsRouter.get("/saved-articles", ...privateRoute, validate(paginationSchema, "query"), asyncHandler(async (req, res) => {
  const { page, limit } = req.query as unknown as { page: number; limit: number };
  const [items, count] = await Promise.all([
    query("SELECT id, news_article_id, created_at FROM saved_news_articles WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", [req.appUser!.id, limit, (page - 1) * limit]),
    query<{ count: string }>("SELECT count(*) FROM saved_news_articles WHERE user_id = $1", [req.appUser!.id])
  ]);
  const total = Number(count.rows[0]?.count ?? 0);
  res.json({ items: items.rows, pagination: pagination(page, limit, total) });
}));
