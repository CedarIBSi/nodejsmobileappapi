import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { isBelowMinimum } from "../lib/app-version.js";
import { isAdminRole } from "../lib/entitlement.js";
import { HttpError } from "../lib/errors.js";
import { privateRoute, resolveOptionalUser } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

/**
 * What the app asks the API about itself: whether this build may continue,
 * whether there is a service notice, and where to drop its measurement.
 * Mounted at /v1/app.
 */
export const appRouter = Router();

const storeUrls = {
  ios: "https://apps.apple.com/app/id6813864921",
  android: "https://play.google.com/store/apps/details?id=com.ibsintelligence.news"
} as const;

type StatusRow = {
  min_ios_version: string;
  min_ios_build: number | null;
  min_android_version: string;
  min_android_build: number | null;
  update_message: string;
  notice_active: boolean;
  notice_level: "info" | "warning";
  notice_title: string | null;
  notice_message: string | null;
  notice_link: string | null;
  notice_until: Date | null;
  updated_at: Date;
};

type AdminStatusRow = StatusRow & {
  updated_by: string | null;
  updated_by_name: string | null;
};

async function readStatus(): Promise<StatusRow> {
  const result = await query<StatusRow>("SELECT * FROM app_status WHERE id = true");
  if (!result.rows[0]) throw new HttpError(500, "app_status row is missing - run migration 035", "APP_STATUS_MISSING");
  return result.rows[0];
}

const statusQuerySchema = z.object({
  platform: z.enum(["ios", "android"]),
  version: z.string().max(20).optional(),
  build: z.coerce.number().int().nonnegative().optional()
});

/**
 * GET /v1/app/status?platform=ios&version=0.3.0&build=7
 *
 * Public and cheap: one row, no auth, cacheable for a minute. The comparison
 * happens here so the app's side is a boolean - a gate that computed its
 * own answer could not be fixed without a build, which is the one thing a
 * gate must never need.
 *
 * `notice` is null when there is nothing to say, rather than absent, so a
 * client can tell "no notice" from "old API that never heard of notices".
 */
appRouter.get(
  "/status",
  validate(statusQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const { platform, version, build } = req.query as unknown as z.infer<typeof statusQuerySchema>;
    const row = await readStatus();

    const required = isBelowMinimum({
      version,
      build,
      minVersion: platform === "ios" ? row.min_ios_version : row.min_android_version,
      minBuild: platform === "ios" ? row.min_ios_build : row.min_android_build
    });

    const noticeLive =
      row.notice_active &&
      Boolean(row.notice_message) &&
      (row.notice_until === null || row.notice_until.getTime() > Date.now());

    res.set("Cache-Control", "public, max-age=60");
    res.json({
      update: {
        required,
        message: row.update_message,
        store_url: storeUrls[platform]
      },
      notice: noticeLive
        ? {
            // The app remembers a dismissed notice by this id; editing the
            // notice changes updated_at and so shows it again.
            id: row.updated_at.toISOString(),
            level: row.notice_level,
            title: row.notice_title,
            message: row.notice_message,
            link: row.notice_link,
            until: row.notice_until
          }
        : null,
      server_time: new Date().toISOString()
    });
  })
);

/** Full editable status configuration for the signed-in admin console. */
appRouter.get(
  "/status/config",
  ...privateRoute,
  asyncHandler(async (req, res) => {
    if (!isAdminRole(req.appUser!.role)) throw new HttpError(403, "Admin role required", "FORBIDDEN");
    const result = await query<AdminStatusRow>(
      `SELECT s.*, COALESCE(u.display_name, u.email) AS updated_by_name
         FROM app_status s LEFT JOIN app_users u ON u.id = s.updated_by
        WHERE s.id = true`
    );
    if (!result.rows[0]) throw new HttpError(500, "app_status row is missing - run migration 035", "APP_STATUS_MISSING");
    res.json({ status: result.rows[0] });
  })
);

const statusUpdateSchema = z
  .object({
    min_ios_version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
    min_ios_build: z.number().int().nonnegative().nullable().optional(),
    min_android_version: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
    min_android_build: z.number().int().nonnegative().nullable().optional(),
    update_message: z.string().min(1).max(500).optional(),
    notice_active: z.boolean().optional(),
    notice_level: z.enum(["info", "warning"]).optional(),
    notice_title: z.string().max(120).nullable().optional(),
    notice_message: z.string().max(500).nullable().optional(),
    notice_link: z.url().nullable().optional(),
    notice_until: z.iso.datetime().nullable().optional()
  })
  .strict();

const updateGateSchema = z.object({
  min_ios_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  min_ios_build: z.number().int().nonnegative().nullable(),
  min_android_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  min_android_build: z.number().int().nonnegative().nullable()
});

/** Count installations whose latest app-open event would be blocked. */
appRouter.post(
  "/status/impact",
  ...privateRoute,
  validate(updateGateSchema),
  asyncHandler(async (req, res) => {
    if (!isAdminRole(req.appUser!.role)) throw new HttpError(403, "Admin role required", "FORBIDDEN");
    const gate = req.body as z.infer<typeof updateGateSchema>;
    const result = await query<{
      platform: "ios" | "android";
      app_version: string | null;
      build: string | null;
      installations: string;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (installation_id)
                installation_id, platform, app_version, build
           FROM app_events
          WHERE name = 'app_open' AND installation_id IS NOT NULL AND platform IS NOT NULL
          ORDER BY installation_id, occurred_at DESC
       )
       SELECT platform, app_version, build, count(*)::text AS installations
         FROM latest GROUP BY platform, app_version, build`
    );
    const counts = { ios: { known: 0, blocked: 0 }, android: { known: 0, blocked: 0 } };
    for (const row of result.rows) {
      const installations = Number(row.installations);
      counts[row.platform].known += installations;
      const build = row.build !== null && /^\d+$/.test(row.build) ? Number(row.build) : undefined;
      if (isBelowMinimum({
        version: row.app_version ?? undefined,
        build,
        minVersion: row.platform === "ios" ? gate.min_ios_version : gate.min_android_version,
        minBuild: row.platform === "ios" ? gate.min_ios_build : gate.min_android_build
      })) counts[row.platform].blocked += installations;
    }
    res.json({
      ...counts,
      known: counts.ios.known + counts.android.known,
      blocked: counts.ios.blocked + counts.android.blocked
    });
  })
);

/**
 * PUT /v1/app/status - admin only. Partial update: send only the fields to
 * change. Returns the whole row so the caller sees the result.
 */
appRouter.put(
  "/status",
  ...privateRoute,
  validate(statusUpdateSchema),
  asyncHandler(async (req, res) => {
    if (!isAdminRole(req.appUser!.role)) throw new HttpError(403, "Admin role required", "FORBIDDEN");

    const changes = Object.entries(req.body as Record<string, unknown>);
    if (changes.length === 0) throw new HttpError(400, "Nothing to update", "VALIDATION_ERROR");

    const assignments = changes.map(([column], index) => `${column} = $${index + 1}`);
    const values = changes.map(([, value]) => value);
    values.push(req.appUser!.id);

    const result = await query<StatusRow>(
      `UPDATE app_status SET ${assignments.join(", ")}, updated_at = now(), updated_by = $${values.length}
        WHERE id = true RETURNING *`,
      values
    );
    res.json({ status: result.rows[0] });
  })
);

/**
 * The events the app may send. An allow-list rather than a free string, so
 * a typo in the app cannot quietly split a count in two, and so nothing a
 * reader typed can become an event name.
 */
const eventNames = [
  "app_open",
  "article_open",
  "insight_open",
  "journal_open",
  "paywall_view",
  "subscribe_tap",
  "purchase_success",
  "search",
  "notification_open"
] as const;

const eventSchema = z.object({
  name: z.enum(eventNames),
  occurred_at: z.iso.datetime(),
  // Small, flat, and never free text from the reader: ids, kinds, counts.
  properties: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()])).optional()
});

const eventsBatchSchema = z.object({
  installation_id: z.uuid().optional(),
  platform: z.enum(["ios", "android"]),
  app_version: z.string().max(20).optional(),
  build: z.string().max(20).optional(),
  events: z.array(eventSchema).min(1).max(50)
});

/**
 * POST /v1/app/events - the app's measurement, in batches of up to fifty.
 *
 * Signed-in or not: with a bearer token the events carry the user id, without
 * one only the installation id. Always 202: the app drops its queue on
 * success and keeps it on failure, so this must never fail for a reason the
 * app cannot fix by retrying.
 */
appRouter.post(
  "/events",
  resolveOptionalUser,
  validate(eventsBatchSchema),
  asyncHandler(async (req, res) => {
    const batch = req.body as z.infer<typeof eventsBatchSchema>;
    const userId = req.appUser?.id ?? null;
    const now = Date.now();

    await transaction(async (client) => {
      for (const event of batch.events) {
        // Clamp clocks that are wildly wrong rather than reject the batch:
        // a phone a year in the future still read the article today.
        const occurred = new Date(event.occurred_at);
        const occurredAt = Math.abs(occurred.getTime() - now) > 7 * 86_400_000 ? new Date(now) : occurred;
        await client.query(
          `INSERT INTO app_events
             (name, occurred_at, user_id, installation_id, platform, app_version, build, properties)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            event.name,
            occurredAt,
            userId,
            batch.installation_id ?? null,
            batch.platform,
            batch.app_version ?? null,
            batch.build ?? null,
            JSON.stringify(event.properties ?? {})
          ]
        );
      }
    });

    res.status(202).json({ accepted: batch.events.length });
  })
);

const summaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7)
});

/**
 * GET /v1/app/events/summary?days=7 - admin only. Counts per event per day
 * from the view, newest day first. Enough to answer the weekly questions
 * without a dashboard; a dashboard can read the same view later.
 */
appRouter.get(
  "/events/summary",
  ...privateRoute,
  validate(summaryQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    if (!isAdminRole(req.appUser!.role)) throw new HttpError(403, "Admin role required", "FORBIDDEN");
    const { days } = req.query as unknown as z.infer<typeof summaryQuerySchema>;

    const result = await query<{
      day: string;
      name: string;
      platform: string | null;
      events: string;
      installations: string;
      users: string;
    }>(
      `SELECT day, name, platform, events, installations, users
         FROM app_events_daily
        WHERE day >= (current_date - ($1::int - 1))
        ORDER BY day DESC, name, platform`,
      [days]
    );

    res.json({
      days,
      rows: result.rows.map((row) => ({
        ...row,
        events: Number(row.events),
        installations: Number(row.installations),
        users: Number(row.users)
      }))
    });
  })
);
