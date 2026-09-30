import type { RequestHandler } from "express";
import { z } from "zod";
import { query, transaction } from "../db/pool.js";
import { asyncHandler } from "./async-handler.js";
import { hasEntitlement, isStaffRole } from "./entitlement.js";

/**
 * The free-read meter on IBSi's editorial programming.
 *
 * Analyst opinions, leadership interviews, podcasts and videos share one
 * allowance: five distinct items per calendar month, counted in Asia/Kolkata,
 * per signed-in user or, before sign-in, per installation. Premium
 * subscribers and staff are never metered. White papers were on the meter
 * until 2026-09-30 and are now free, so `whitepaper` is not a content type
 * here; migration 031 clears the reads spent on them.
 *
 * Two operations, deliberately separate. `consumeInsightRead` is the only
 * place a read is spent; the app calls it (POST /v1/insights/access) before
 * opening an item, and it is idempotent for an item already read this month.
 * `hasInsightRead` asks whether that spend happened and is what the content
 * routes check before serving a body, an audio URL, a YouTube id or a PDF
 * link - so the allowance is enforced on the content itself, not only in the
 * client. A caller that skips /access gets nothing.
 */
export const insightContentTypes = [
  "analyst_opinion",
  "leadership_interview",
  "podcast",
  "video"
] as const;

export type InsightContentType = (typeof insightContentTypes)[number];

export const freeInsightReads = 5;
export const meterTimezone = "Asia/Kolkata";

export type InsightAccess = {
  allowed: boolean;
  reason: "free" | "premium" | "monthly_limit_reached";
  remaining_free_reads: number;
  period_timezone: string;
  requires_authentication: boolean;
  requires_subscription: boolean;
};

const installationIdSchema = z.uuid().optional();

/** Body of POST /v1/insights/access. */
export const insightAccessSchema = z.object({
  content_type: z.enum(insightContentTypes),
  content_id: z.string().trim().min(1).max(255),
  installation_id: installationIdSchema
});

/**
 * The installation id a metered content route reads, in its query string or
 * body, so a signed-out reader can present the same identity /access spent
 * the read under.
 */
export const meteredCallerSchema = z.object({ installation_id: installationIdSchema });

/**
 * The same, for a POST: a signed-in caller may send no body at all, and an
 * absent body must read as "no installation id", not as a 400.
 */
export const meteredCallerBodySchema = meteredCallerSchema.optional();

/**
 * Editorial routes accept both the bare WordPress id and the app's
 * `postid-123` spelling. The meter must see one item, not two, so the prefix
 * is dropped before anything is counted or compared.
 */
export function normaliseInsightContentId(contentId: string): string {
  return contentId.trim().replace(/^postid-/i, "");
}

const periodStartSql =
  "SELECT date_trunc('month', timezone('Asia/Kolkata', now()))::date::text AS period_start";

type Reader = {
  installationId: string | null;
  role?: string | null;
  userId: string | null;
};

type MeterInput = Reader & {
  contentId: string;
  contentType: InsightContentType;
};

function denied(reader: Reader): InsightAccess {
  return {
    allowed: false,
    reason: "monthly_limit_reached",
    remaining_free_reads: 0,
    period_timezone: meterTimezone,
    requires_authentication: !reader.userId,
    requires_subscription: true
  };
}

function premium(): InsightAccess {
  return {
    allowed: true,
    reason: "premium",
    remaining_free_reads: freeInsightReads,
    period_timezone: meterTimezone,
    requires_authentication: false,
    requires_subscription: false
  };
}

function free(remaining: number): InsightAccess {
  return {
    allowed: true,
    reason: "free",
    remaining_free_reads: Math.max(0, remaining),
    period_timezone: meterTimezone,
    requires_authentication: false,
    requires_subscription: false
  };
}

/**
 * Spends one free read on this item, unless one was already spent on it this
 * month, the reader is premium or staff, or the allowance is gone.
 *
 * Runs under an advisory lock on the reader's identity, so two taps in quick
 * succession cannot both see "four used" and both insert a fifth and a sixth.
 */
export async function consumeInsightRead(input: MeterInput): Promise<InsightAccess> {
  const contentId = normaliseInsightContentId(input.contentId);

  return transaction(async (client) => {
    const periodResult = await client.query<{ period_start: string }>(periodStartSql);
    const periodStart = periodResult.rows[0]!.period_start;
    const meterKey = input.userId ? `user:${input.userId}` : `installation:${input.installationId}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [meterKey]);

    if (input.userId) {
      if (isStaffRole(input.role)) return premium();

      // Every product grants 'insights', so this is "any subscriber" - but
      // asked by type, so a product without it could be added later without
      // this silently letting its buyers past the meter.
      const entitlement = await client.query(
        `SELECT 1 FROM entitlements WHERE user_id = $1 AND status = 'active'
         AND entitlement_type = 'insights'
         AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) LIMIT 1`,
        [input.userId]
      );
      if (entitlement.rowCount) return premium();

      // First metered call after sign-in: whatever this installation read
      // anonymously this month now counts against the account, so signing in
      // is not a way to a second allowance.
      if (input.installationId) {
        await client.query(
          `INSERT INTO insight_access (user_id, content_type, content_id, period_start, first_viewed_at)
           SELECT $1, content_type, content_id, period_start, first_viewed_at
           FROM insight_access WHERE installation_id = $2 AND period_start = $3
           ON CONFLICT (user_id, content_type, content_id, period_start) WHERE user_id IS NOT NULL DO NOTHING`,
          [input.userId, input.installationId, periodStart]
        );
        await client.query(
          "DELETE FROM insight_access WHERE installation_id = $1 AND period_start = $2",
          [input.installationId, periodStart]
        );
      }
    }

    const identityColumn = input.userId ? "user_id" : "installation_id";
    const identityValue = input.userId ?? input.installationId;
    const existing = await client.query(
      `SELECT 1 FROM insight_access
       WHERE ${identityColumn} = $1 AND content_type = $2 AND content_id = $3 AND period_start = $4`,
      [identityValue, input.contentType, contentId, periodStart]
    );
    const countResult = await client.query<{ count: string }>(
      `SELECT count(*) FROM insight_access WHERE ${identityColumn} = $1 AND period_start = $2`,
      [identityValue, periodStart]
    );
    const used = Number(countResult.rows[0]!.count);

    if (existing.rowCount) return free(freeInsightReads - used);
    if (used >= freeInsightReads) return denied(input);

    await client.query(
      `INSERT INTO insight_access (${identityColumn}, content_type, content_id, period_start)
       VALUES ($1, $2, $3, $4)`,
      [identityValue, input.contentType, contentId, periodStart]
    );
    return free(freeInsightReads - used - 1);
  });
}

/**
 * Whether this reader may be served the item now: premium, staff, or a read
 * already spent on it this month. Never spends one itself.
 */
export async function hasInsightRead(input: MeterInput): Promise<boolean> {
  if (isStaffRole(input.role)) return true;
  if (input.userId && (await hasEntitlement(input.userId, input.role, "insights"))) return true;

  const identityColumn = input.userId ? "user_id" : "installation_id";
  const identityValue = input.userId ?? input.installationId;
  if (!identityValue) return false;

  const periodResult = await query<{ period_start: string }>(periodStartSql);
  const consumed = await query(
    `SELECT 1 FROM insight_access
     WHERE ${identityColumn} = $1 AND content_type = $2 AND content_id = $3 AND period_start = $4`,
    [
      identityValue,
      input.contentType,
      normaliseInsightContentId(input.contentId),
      periodResult.rows[0]!.period_start
    ]
  );
  return Boolean(consumed.rowCount);
}

/**
 * Guards a content route. Mount it after resolveOptionalUser and after the
 * validators for `params` and for the source that carries `installation_id`
 * (`query` for a GET, `body` for a POST). Answers 402 with the same envelope
 * POST /access uses for a refusal, so the app has one paywall code path.
 */
export function meteredInsight(
  contentType: InsightContentType,
  idParam: string,
  callerSource: "body" | "query" = "query"
): RequestHandler {
  return asyncHandler(async (req, res, next) => {
    const params = req.params as Record<string, string>;
    const caller = (req[callerSource] ?? {}) as { installation_id?: string };
    const reader: Reader = {
      installationId: caller.installation_id ?? null,
      role: req.appUser?.role,
      userId: req.appUser?.id ?? null
    };

    const allowed = await hasInsightRead({
      ...reader,
      contentId: params[idParam]!,
      contentType
    });
    if (!allowed) {
      // Not `public`, and not cacheable at all: the answer depends on who
      // asked, and an edge holding a refusal would keep refusing a reader who
      // has since paid.
      res.set("Cache-Control", "private, no-store");
      res.status(402).json({ access: denied(reader) });
      return;
    }
    next();
  });
}
