import { Router } from "express";
import { z } from "zod";
import { isAdminRole } from "../lib/entitlement.js";
import { HttpError } from "../lib/errors.js";
import { asyncHandler } from "../lib/async-handler.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { broadcastArticle, sendPushNotificationToUser } from "../services/expoPush.js";
import { query } from "../db/pool.js";

export const notificationRouter = Router();

const sendSchema = z.object({
  user_id: z.uuid(),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
  data: z.record(z.string(), z.unknown()).optional()
});

// No automatic triggers yet (breaking news, new journal issues, etc.) - this
// is the manual/staff-only way to fire a push notification to one user while
// those triggers are still being decided.
notificationRouter.post("/send", ...privateRoute, validate(sendSchema), asyncHandler(async (req, res) => {
  if (!isAdminRole(req.appUser!.role)) {
    throw new HttpError(403, "Admin role required", "FORBIDDEN");
  }

  const result = await sendPushNotificationToUser(req.body.user_id, {
    title: req.body.title,
    body: req.body.body,
    data: req.body.data
  });
  res.json(result);
}));

const articleBroadcastSchema = z.object({
  article_id: z.string().min(1).max(255),
  headline: z.string().min(1).max(200),
  summary: z.string().min(1).max(500).optional(),
  image_url: z.url().optional()
});

// An editor chooses one article; the server fixes the visible sender name to
// IBS Intelligence and snapshots every currently registered Expo token. The
// article id in `data` is the mobile app's safe navigation contract.
notificationRouter.post(
  "/article",
  ...privateRoute,
  validate(articleBroadcastSchema),
  asyncHandler(async (req, res) => {
    if (!isAdminRole(req.appUser!.role)) {
      throw new HttpError(403, "Admin role required", "FORBIDDEN");
    }
    const result = await broadcastArticle({
      articleId: req.body.article_id,
      headline: req.body.headline,
      summary: req.body.summary,
      imageUrl: req.body.image_url,
      requestedBy: req.appUser!.id
    });
    res.status(202).json(result);
  })
);

notificationRouter.get("/article/:broadcastId", ...privateRoute, asyncHandler(async (req, res) => {
  if (!isAdminRole(req.appUser!.role)) {
    throw new HttpError(403, "Admin role required", "FORBIDDEN");
  }
  const result = await query(
    `SELECT id, article_id, headline, status, target_count, accepted_count,
            delivered_count, failed_count, created_at, completed_at, updated_at
       FROM article_push_broadcasts WHERE id = $1`,
    [req.params.broadcastId]
  );
  if (!result.rows[0]) throw new HttpError(404, "Broadcast not found", "NOT_FOUND");
  res.json({ broadcast: result.rows[0] });
}));
