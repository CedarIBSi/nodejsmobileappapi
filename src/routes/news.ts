import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { isStaffRole } from "../lib/entitlement.js";
import { HttpError } from "../lib/errors.js";
import { pagination, paginationSchema } from "../lib/pagination.js";
import { privateRoute, resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  getArticleContent,
  listNews,
  listNewsCategories,
  searchNews
} from "../services/wordpress.js";

export const newsRouter = Router();

const articleSchema = z.object({ news_article_id: z.string().trim().min(1).max(255) });
const articleParams = z.object({ news_article_id: z.string().trim().min(1).max(255) });
const articleBodyQuery = z.object({ installation_id: z.uuid().optional() });
const accessSchema = z.object({
  news_article_id: z.string().trim().min(1).max(255),
  installation_id: z.uuid().optional()
});
const newsListSchema = paginationSchema.extend({
  category: z.coerce.number().int().positive().optional()
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

/** The meter's period, in the timezone the free allowance is counted in. */
async function currentPeriodStart(): Promise<string> {
  const result = await query<{ period_start: string }>(
    "SELECT date_trunc('month', timezone('Asia/Kolkata', now()))::date::text AS period_start"
  );
  return result.rows[0]!.period_start;
}

/**
 * Whether this reader may be served the body of one article.
 *
 * Deliberately does not consume a free article: POST /access is the single
 * place that spends one, and the app calls it before opening a story. This
 * asks only whether the spend already happened - so a reader who opened the
 * article legitimately can re-read it, and a caller who skipped /access
 * entirely gets nothing.
 */
async function mayReadArticleBody(input: {
  articleId: string;
  installationId?: string;
  role?: string | null;
  userId: string | null;
}): Promise<boolean> {
  if (isStaffRole(input.role)) return true;

  if (input.userId) {
    const entitlement = await query(
      `SELECT 1 FROM entitlements WHERE user_id = $1 AND status = 'active'
       AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) LIMIT 1`,
      [input.userId]
    );
    if (entitlement.rowCount) return true;
  }

  const identityColumn = input.userId ? "user_id" : "installation_id";
  const identityValue = input.userId ?? input.installationId;
  if (!identityValue) return false;

  const consumed = await query(
    `SELECT 1 FROM news_article_access
     WHERE ${identityColumn} = $1 AND news_article_id = $2 AND period_start = $3`,
    [identityValue, input.articleId, await currentPeriodStart()]
  );
  return Boolean(consumed.rowCount);
}


newsRouter.get("/", validate(newsListSchema, "query"), asyncHandler(async (req, res) => {
  const { category, limit, page } = req.query as unknown as {
    category?: number;
    limit: number;
    page: number;
  };
  const { items, total } = await listNews(page, limit, category);
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ articles: items, pagination: pagination(page, limit, total) });
}));

newsRouter.get("/search", validate(newsSearchSchema, "query"), asyncHandler(async (req, res) => {
  const { category, limit, page, q } = req.query as unknown as {
    category?: number;
    limit: number;
    page: number;
    q: string;
  };
  const { items, total } = await searchNews(q, page, limit, category);
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ articles: items, pagination: pagination(page, limit, total) });
}));

newsRouter.get("/categories", asyncHandler(async (_req, res) => {
  const categories = await listNewsCategories();
  res.set("Cache-Control", `public, max-age=${publicCacheSeconds}`);
  res.json({ categories });
}));

// The article body is the paywalled thing itself, so the meter is enforced
// here and not only in the client that calls POST /access. Without this the
// five-article allowance is advisory: the id is in every listing response, and
// the body was served to anyone who asked for it.
newsRouter.get(
  "/articles/:news_article_id",
  resolveOptionalUser,
  validate(articleParams, "params"),
  validate(articleBodyQuery, "query"),
  asyncHandler(async (req, res) => {
    const { news_article_id: articleId } = req.params as { news_article_id: string };
    const { installation_id: installationId } = req.query as unknown as {
      installation_id?: string;
    };

    const allowed = await mayReadArticleBody({
      articleId,
      installationId,
      role: req.appUser?.role,
      userId: req.appUser?.id ?? null
    });

    if (!allowed) {
      // Same envelope POST /access answers 402 with, so the app's existing
      // paywall handling reads this response without a second code path.
      res.status(402).json({
        access: {
          allowed: false,
          reason: "monthly_limit_reached",
          remaining_free_articles: 0,
          period_timezone: "Asia/Kolkata",
          requires_authentication: !req.appUser,
          requires_subscription: true
        }
      });
      return;
    }

    const content = await getArticleContent(articleId);

    if (content === null || content.text === null) {
      throw new HttpError(404, "Article not found", "ARTICLE_NOT_FOUND");
    }

    // Not `public`: the answer now depends on who asked, so a shared cache
    // holding one reader's copy would hand it to everyone behind that edge.
    res.set("Cache-Control", "private, no-store");
    // `body` stays the flattened text every shipped build reads; `body_html`
    // is additive, for clients that can render the real markup.
    res.json({
      article: { body: content.text, body_html: content.html, id: articleId }
    });
  })
);

newsRouter.post("/access", resolveOptionalUser, validate(accessSchema), asyncHandler(async (req, res) => {
  const userId = req.appUser?.id ?? null;
  const installationId = req.body.installation_id ?? null;
  if (!userId && !installationId) {
    res.status(400).json({ error: { code: "INSTALLATION_ID_REQUIRED", message: "installation_id is required before sign-in" } });
    return;
  }

  const result = await transaction(async (client) => {
    const periodResult = await client.query<{ period_start: string }>(
      "SELECT date_trunc('month', timezone('Asia/Kolkata', now()))::date::text AS period_start"
    );
    const periodStart = periodResult.rows[0]!.period_start;
    const meterKey = userId ? `user:${userId}` : `installation:${installationId}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [meterKey]);

    if (userId) {
      // Staff bypass the meter entirely, without consuming a free article.
      if (isStaffRole(req.appUser?.role)) {
        return { allowed: true, reason: "premium", remaining_free_articles: 5 };
      }

      const entitlement = await client.query(
        `SELECT 1 FROM entitlements WHERE user_id = $1 AND status = 'active'
         AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) LIMIT 1`,
        [userId]
      );
      if (entitlement.rowCount) {
        return { allowed: true, reason: "premium", remaining_free_articles: 5 };
      }

      if (installationId) {
        await client.query(
          `INSERT INTO news_article_access (user_id, news_article_id, period_start, first_viewed_at)
           SELECT $1, news_article_id, period_start, first_viewed_at
           FROM news_article_access WHERE installation_id = $2 AND period_start = $3
           ON CONFLICT (user_id, news_article_id, period_start) WHERE user_id IS NOT NULL DO NOTHING`,
          [userId, installationId, periodStart]
        );
        await client.query(
          "DELETE FROM news_article_access WHERE installation_id = $1 AND period_start = $2",
          [installationId, periodStart]
        );
      }
    }

    const identityColumn = userId ? "user_id" : "installation_id";
    const identityValue = userId ?? installationId;
    const existing = await client.query(
      `SELECT 1 FROM news_article_access
       WHERE ${identityColumn} = $1 AND news_article_id = $2 AND period_start = $3`,
      [identityValue, req.body.news_article_id, periodStart]
    );
    const countResult = await client.query<{ count: string }>(
      `SELECT count(*) FROM news_article_access WHERE ${identityColumn} = $1 AND period_start = $2`,
      [identityValue, periodStart]
    );
    const used = Number(countResult.rows[0]!.count);
    if (existing.rowCount) {
      return { allowed: true, reason: "free", remaining_free_articles: Math.max(0, 5 - used) };
    }
    if (used >= 5) {
      return { allowed: false, reason: "monthly_limit_reached", remaining_free_articles: 0 };
    }
    await client.query(
      `INSERT INTO news_article_access (${identityColumn}, news_article_id, period_start) VALUES ($1, $2, $3)`,
      [identityValue, req.body.news_article_id, periodStart]
    );
    return { allowed: true, reason: "free", remaining_free_articles: 4 - used };
  });

  res.status(result.allowed ? 200 : 402).json({
    access: {
      ...result,
      period_timezone: "Asia/Kolkata",
      requires_authentication: !result.allowed && !userId,
      requires_subscription: !result.allowed
    }
  });
}));

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
