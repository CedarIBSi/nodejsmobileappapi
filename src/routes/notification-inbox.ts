import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { privateRoute, resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import type { PushData } from "../services/pushBroadcast.js";

/**
 * The app's notification bell: what editors have pushed in the last 30 days,
 * for this reader. It reads push_broadcasts directly, so anything sent from
 * the console appears here with no extra step - including for readers who
 * have push turned off, which is the point of having a bell at all.
 *
 * Audience is decided at read time, against the reader's entitlements now,
 * not at the moment of sending. A reader who subscribed yesterday sees
 * today's subscriber notices and last week's; that is the more useful
 * mistake to make. Signed out, a reader has no entitlements, so they see
 * "all" and "free" sends (and "platform" when the app says which it is).
 */
export const notificationInboxRouter = Router();

type InboxRow = {
  id: string;
  kind: "article" | "message";
  article_id: string | null;
  headline: string | null;
  summary: string | null;
  title: string | null;
  body: string | null;
  image_url: string | null;
  data: PushData;
  sent_at: Date;
};

const listQuery = z.object({ platform: z.enum(["ios", "android"]).optional() });
const seenSchema = z.object({ seen_at: z.iso.datetime() });

const activeEntitlement = `SELECT 1 FROM entitlements e
  WHERE e.user_id = $1 AND e.status = 'active'
    AND e.starts_at <= now() AND (e.ends_at IS NULL OR e.ends_at > now())`;

notificationInboxRouter.get(
  "/inbox",
  resolveOptionalUser,
  validate(listQuery, "query"),
  asyncHandler(async (req, res) => {
    const { platform } = req.query as z.infer<typeof listQuery>;
    const userId = req.appUser?.id ?? null;

    // Sent means past the scheduler. A broadcast that failed only because
    // nobody in the audience had push on was still meant for them, so it
    // counts; one Expo rejected outright may be resent, so it does not, or
    // the bell would show it twice.
    const result = await query<InboxRow>(
      `SELECT b.id, b.kind, b.article_id, b.headline, b.summary, b.title, b.body,
              b.image_url, b.data, COALESCE(b.scheduled_at, b.created_at) AS sent_at
         FROM push_broadcasts b
        WHERE (b.status IN ('processing', 'accepted', 'partial')
               OR (b.status = 'failed' AND b.target_count = 0))
          AND COALESCE(b.scheduled_at, b.created_at) > now() - interval '30 days'
          AND CASE b.audience->>'type'
                WHEN 'all' THEN TRUE
                WHEN 'platform' THEN b.audience->>'platform' = $2
                WHEN 'subscribers' THEN EXISTS (${activeEntitlement})
                WHEN 'free' THEN NOT EXISTS (${activeEntitlement})
                WHEN 'entitlement' THEN EXISTS (${activeEntitlement}
                  AND e.entitlement_type = b.audience->>'entitlement_type')
                ELSE FALSE
              END
        ORDER BY sent_at DESC
        LIMIT 50`,
      [userId, platform ?? null]
    );

    let seenAt: Date | null = null;
    if (userId) {
      const seen = await query<{ seen_at: Date }>(
        "SELECT seen_at FROM notification_inbox_seen WHERE user_id = $1",
        [userId]
      );
      seenAt = seen.rows[0]?.seen_at ?? null;
    }

    res.json({
      items: result.rows.map((row) => row.kind === "article"
        ? {
            id: row.id,
            title: row.headline,
            body: row.summary,
            image_url: row.image_url,
            sent_at: row.sent_at,
            // Article broadcasts always carry an id; push_broadcasts_article_once
            // and createBroadcast both depend on it.
            data: { type: "news_article", article_id: row.article_id! } satisfies PushData
          }
        : {
            id: row.id,
            title: row.title,
            body: row.body,
            image_url: row.image_url,
            sent_at: row.sent_at,
            data: row.data
          }),
      // Null signed out, or for a reader who has never opened the bell; the
      // app treats both as "everything is new".
      seen_at: seenAt
    });
  })
);

/**
 * The reader opened the bell. The app sends the newest sent_at it actually
 * showed rather than letting the server use now(), so a notification that
 * lands between loading the list and this call still counts as unread.
 * Never moves backwards, and never past now.
 */
notificationInboxRouter.post(
  "/inbox/seen",
  ...privateRoute,
  validate(seenSchema),
  asyncHandler(async (req, res) => {
    const result = await query<{ seen_at: Date }>(
      `INSERT INTO notification_inbox_seen (user_id, seen_at)
       VALUES ($1, LEAST($2::timestamptz, now()))
       ON CONFLICT (user_id) DO UPDATE
         SET seen_at = GREATEST(notification_inbox_seen.seen_at, EXCLUDED.seen_at),
             updated_at = now()
       RETURNING seen_at`,
      [req.appUser!.id, req.body.seen_at]
    );
    res.json({ seen_at: result.rows[0]!.seen_at });
  })
);
