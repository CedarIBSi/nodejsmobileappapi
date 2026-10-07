import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { isAdminRole } from "../lib/entitlement.js";
import { HttpError } from "../lib/errors.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  audienceCount,
  createBroadcast,
  messageForBroadcast,
  runBroadcast,
  type PushAudience,
  type PushData
} from "../services/pushBroadcast.js";
import { sendPushNotificationToUser } from "../services/expoPush.js";
import { listNews } from "../services/wordpress.js";

export const notificationConsoleRouter = Router();

const adminOnly: RequestHandler = (req, _res, next) => {
  if (!isAdminRole(req.appUser?.role)) {
    next(new HttpError(403, "Admin role required", "FORBIDDEN"));
    return;
  }
  next();
};
const secured = [...privateRoute, adminOnly];

const audienceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }),
  z.object({ type: z.literal("platform"), platform: z.enum(["ios", "android"]) }),
  z.object({ type: z.literal("subscribers") }),
  z.object({ type: z.literal("free") }),
  z.object({
    type: z.literal("entitlement"),
    entitlement_type: z.enum(["journal_india", "journal_global", "insights"])
  })
]);

const targetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("screen"),
    screen: z.enum(["news", "exclusive", "journal", "subscribe", "events", "about"])
  }),
  z.object({ type: z.literal("article"), article_id: z.string().trim().min(1).max(255) }),
  z.object({ type: z.literal("url"), url: z.url().refine((url) => url.startsWith("https://"), "HTTPS URL required") })
]);

const articlePart = z.object({
  kind: z.literal("article"),
  article_id: z.string().trim().min(1).max(255),
  headline: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().min(1).max(500).optional(),
  image_url: z.url().refine((url) => url.startsWith("https://"), "HTTPS URL required").optional()
});

const messagePart = z.object({
  kind: z.literal("message"),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(1000),
  image_url: z.url().refine((url) => url.startsWith("https://"), "HTTPS URL required").optional(),
  target: targetSchema
});

const broadcastSchema = z.discriminatedUnion("kind", [
  articlePart.extend({
    audience: audienceSchema,
    scheduled_at: z.iso.datetime().optional(),
    confirm: z.literal(true),
    confirm_cap: z.boolean().optional()
  }),
  messagePart.extend({
    audience: audienceSchema,
    scheduled_at: z.iso.datetime().optional(),
    confirm: z.literal(true),
    confirm_cap: z.boolean().optional()
  })
]);

const previewSchema = z.discriminatedUnion("kind", [articlePart, messagePart]);
const articlesQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });
const broadcastsQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const idParams = z.object({ id: z.uuid() });

function targetData(target: z.infer<typeof targetSchema>): PushData {
  if (target.type === "article") return { type: "news_article", article_id: target.article_id };
  return target;
}

async function enforceDailyCap(confirmCap?: boolean): Promise<void> {
  const result = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM push_broadcasts
     WHERE status <> 'cancelled' AND created_at >= now() - interval '24 hours'`
  );
  const count = Number(result.rows[0]?.count ?? 0);
  if (count >= 3 && !confirmCap) {
    const error = new HttpError(429, `This is notification ${count + 1} in the last 24 hours`, "DAILY_CAP");
    Object.assign(error, { details: { count, next: count + 1 } });
    throw error;
  }
}

notificationConsoleRouter.get(
  "/articles",
  ...secured,
  validate(articlesQuery, "query"),
  asyncHandler(async (req, res) => {
    const { limit } = req.query as unknown as { limit: number };
    const { items } = await listNews(1, limit);
    const ids = items.map((item) => String(item.id));
    // Sent badges are useful but not worth taking the editorial feed down for.
    // A transient database/read error is logged and the articles still load;
    // sending remains protected by the unique index itself.
    let sent: { rows: Array<{ article_id: string }> } = { rows: [] };
    if (ids.length) {
      try {
        sent = await query<{ article_id: string }>(
          "SELECT article_id FROM push_broadcasts WHERE article_id = ANY($1::text[])",
          [ids]
        );
      } catch (error) {
        req.log.error({ err: error }, "Could not load notification Sent badges");
      }
    }
    const notified = new Set(sent.rows.map((row) => row.article_id));
    res.json({
      articles: items.map((item) => ({
        id: String(item.id),
        headline: item.title,
        image_url: item.image_url,
        published_at: item.published_at,
        already_notified: notified.has(String(item.id))
      }))
    });
  })
);

notificationConsoleRouter.post(
  "/broadcast",
  ...secured,
  validate(broadcastSchema),
  asyncHandler(async (req, res) => {
    await enforceDailyCap(req.body.confirm_cap);
    const scheduledAt = req.body.scheduled_at ? new Date(req.body.scheduled_at) : undefined;
    const row = req.body.kind === "article"
      ? await createBroadcast({
          kind: "article",
          articleId: req.body.article_id,
          headline: req.body.headline,
          summary: req.body.summary,
          imageUrl: req.body.image_url,
          audience: req.body.audience as PushAudience,
          scheduledAt,
          requestedBy: req.appUser!.id
        })
      : await createBroadcast({
          kind: "message",
          title: req.body.title,
          body: req.body.body,
          imageUrl: req.body.image_url,
          data: targetData(req.body.target),
          audience: req.body.audience as PushAudience,
          scheduledAt,
          requestedBy: req.appUser!.id
        });
    const result = row.status === "scheduled" ? row : await runBroadcast(row.id);
    res.status(202).json({ broadcast: result });
  })
);

notificationConsoleRouter.post(
  "/preview",
  ...secured,
  validate(previewSchema),
  asyncHandler(async (req, res) => {
    let message;
    if (req.body.kind === "article") {
      const metadata = !req.body.headline || !req.body.image_url
        ? await import("../services/wordpress.js").then(({ getArticleMetadata }) => getArticleMetadata(req.body.article_id))
        : null;
      const headline = req.body.headline || metadata?.headline;
      if (!headline) throw new HttpError(422, "Article metadata unavailable", "ARTICLE_METADATA_UNAVAILABLE");
      const image = req.body.image_url || metadata?.image_url || undefined;
      message = {
        title: "IBS Intelligence",
        body: headline,
        sound: "default" as const,
        ...(image ? { richContent: { image }, mutableContent: true } : {}),
        data: { type: "news_article", article_id: req.body.article_id, ...(image ? { image_url: image } : {}) }
      };
    } else {
      message = messageForBroadcast({
        id: "preview",
        kind: "message",
        article_id: null,
        headline: null,
        image_url: req.body.image_url ?? null,
        title: req.body.title,
        body: req.body.body,
        data: targetData(req.body.target),
        audience: { type: "all" },
        status: "preview"
      });
    }
    res.json(await sendPushNotificationToUser(req.appUser!.id, message));
  })
);

notificationConsoleRouter.get(
  "/audience-count",
  ...secured,
  asyncHandler(async (req, res) => {
    if (typeof req.query.audience !== "string") throw new HttpError(400, "Audience is required", "VALIDATION_ERROR");
    let parsed: unknown;
    try { parsed = JSON.parse(req.query.audience); } catch { throw new HttpError(400, "Invalid audience JSON", "VALIDATION_ERROR"); }
    const audience = audienceSchema.safeParse(parsed);
    if (!audience.success) throw Object.assign(new HttpError(400, "Invalid audience", "VALIDATION_ERROR"), { details: audience.error.flatten() });
    res.json(await audienceCount(audience.data));
  })
);

notificationConsoleRouter.get(
  "/broadcasts",
  ...secured,
  validate(broadcastsQuery, "query"),
  asyncHandler(async (req, res) => {
    const { limit } = req.query as unknown as { limit: number };
    const result = await query(
      `SELECT b.id, b.kind, b.article_id, b.headline, b.title, b.body, b.image_url,
              b.data, b.audience, b.status, b.target_count, b.accepted_count,
              b.delivered_count, b.failed_count, b.scheduled_at, b.cancelled_at,
              b.created_at, b.completed_at, b.updated_at,
              COALESCE(u.display_name, u.email) AS requested_by_name
         FROM push_broadcasts b LEFT JOIN app_users u ON u.id = b.requested_by
        ORDER BY b.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ broadcasts: result.rows });
  })
);

notificationConsoleRouter.delete(
  "/broadcasts/:id",
  ...secured,
  validate(idParams, "params"),
  asyncHandler(async (req, res) => {
    const result = await query(
      `UPDATE push_broadcasts SET status = 'cancelled', cancelled_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'scheduled' RETURNING id, status, cancelled_at`,
      [req.params.id]
    );
    if (!result.rows[0]) throw new HttpError(409, "Only scheduled broadcasts can be cancelled", "BROADCAST_NOT_SCHEDULED");
    res.json({ broadcast: result.rows[0] });
  })
);
