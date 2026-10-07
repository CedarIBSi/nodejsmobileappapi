import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { isAdminRole } from "../lib/entitlement.js";
import { HttpError } from "../lib/errors.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";

export const adminSubscriberRouter = Router();

const adminOnly: RequestHandler = (req, _res, next) => {
  if (!isAdminRole(req.appUser?.role)) return next(new HttpError(403, "Admin role required", "FORBIDDEN"));
  next();
};
const secured = [...privateRoute, adminOnly];

const listQuery = z.object({
  search: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});
const idParams = z.object({ id: z.uuid() });

function statusLabel(status: string, currentEnd: Date | null): string {
  if (currentEnd && currentEnd.getTime() <= Date.now() && ["active", "trialing", "canceled"].includes(status)) return "Expired";
  const labels: Record<string, string> = {
    active: "Active",
    trialing: "Trial",
    in_grace_period: "Grace period",
    billing_grace_period: "Grace period",
    billing_retry: "Billing retry",
    on_hold: "On hold",
    paused: "Paused",
    canceled: "Cancelled — access continues",
    expired: "Expired",
    revoked: "Refunded or revoked",
    pending_purchase_canceled: "Purchase cancelled"
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

adminSubscriberRouter.get(
  "/overview",
  ...secured,
  asyncHandler(async (_req, res) => {
    const [products, statuses, stores, windows, movement, totals] = await Promise.all([
      query<{ product_code: string; interval: string; subscriptions: string }>(
        `SELECT p.product_code, p."interval" AS "interval", count(*)::text AS subscriptions
           FROM subscriptions s JOIN subscription_plans p ON p.id = s.local_plan_id
          GROUP BY p.product_code, p."interval" ORDER BY p.product_code, p."interval"`
      ),
      query<{ status: string; subscriptions: string }>(
        `SELECT CASE
                  WHEN current_end <= now() AND status IN ('active','trialing','canceled') THEN 'expired'
                  ELSE status
                END AS status,
                count(*)::text AS subscriptions
           FROM subscriptions
          GROUP BY 1 ORDER BY 1`
      ),
      query<{ provider: string; subscriptions: string }>(
        `SELECT provider, count(*)::text AS subscriptions FROM subscriptions GROUP BY provider ORDER BY provider`
      ),
      query<{ renewing_7: string; renewing_30: string; expiring_7: string; expiring_30: string }>(
        `SELECT
           count(*) FILTER (WHERE status NOT IN ('canceled','expired','revoked','pending_purchase_canceled') AND current_end > now() AND current_end <= now() + interval '7 days')::text AS renewing_7,
           count(*) FILTER (WHERE status NOT IN ('canceled','expired','revoked','pending_purchase_canceled') AND current_end > now() AND current_end <= now() + interval '30 days')::text AS renewing_30,
           count(*) FILTER (WHERE status = 'canceled' AND current_end > now() AND current_end <= now() + interval '7 days')::text AS expiring_7,
           count(*) FILTER (WHERE status = 'canceled' AND current_end > now() AND current_end <= now() + interval '30 days')::text AS expiring_30
         FROM subscriptions`
      ),
      query<{ movement: string; events: string }>(
        `SELECT movement, count(*)::text AS events FROM (
           SELECT CASE
             WHEN provider = 'google_play' AND event_type = '2' THEN 'renewed'
             WHEN provider = 'apple' AND event_type = 'DID_RENEW' THEN 'renewed'
             WHEN provider = 'google_play' AND event_type = '3' THEN 'cancelled'
             WHEN provider = 'apple' AND event_type = 'DID_CHANGE_RENEWAL_STATUS' THEN 'cancelled'
             WHEN provider = 'google_play' AND event_type = '13' THEN 'lapsed'
             WHEN provider = 'apple' AND event_type IN ('EXPIRED','GRACE_PERIOD_EXPIRED') THEN 'lapsed'
             ELSE NULL END AS movement
           FROM store_events WHERE created_at >= now() - interval '30 days'
         ) movement WHERE movement IS NOT NULL GROUP BY movement`
      ),
      query<{ total: string; current_access: string; new_30: string }>(
        `SELECT count(*)::text AS total,
          count(*) FILTER (WHERE status IN ('active','trialing','in_grace_period','billing_grace_period','canceled') AND (current_end IS NULL OR current_end > now()))::text AS current_access,
          count(*) FILTER (WHERE created_at >= now() - interval '30 days')::text AS new_30
         FROM subscriptions`
      )
    ]);
    const movementMap = new Map(movement.rows.map((row) => [row.movement, Number(row.events)]));
    res.json({
      total: Number(totals.rows[0]?.total ?? 0),
      current_access: Number(totals.rows[0]?.current_access ?? 0),
      products: products.rows.map((row) => ({ ...row, subscriptions: Number(row.subscriptions) })),
      statuses: statuses.rows.map((row) => ({ status: row.status, label: statusLabel(row.status, null), subscriptions: Number(row.subscriptions) })),
      stores: stores.rows.map((row) => ({ ...row, subscriptions: Number(row.subscriptions) })),
      windows: Object.fromEntries(Object.entries(windows.rows[0] ?? {}).map(([key, value]) => [key, Number(value)])),
      movement: { new: Number(totals.rows[0]?.new_30 ?? 0), renewed: movementMap.get("renewed") ?? 0, cancelled: movementMap.get("cancelled") ?? 0, lapsed: movementMap.get("lapsed") ?? 0 }
    });
  })
);

adminSubscriberRouter.get(
  "/finance",
  ...secured,
  asyncHandler(async (_req, res) => {
    const result = await query<{
      currency: string; environment: string; gross_micros: string; proceeds_micros: string;
      provider: string; refund_micros: string; transactions: string;
    }>(
      `SELECT provider, environment, currency,
              count(*)::text AS transactions,
              COALESCE(sum(gross_amount_micros), 0)::text AS gross_micros,
              COALESCE(sum(refund_amount_micros), 0)::text AS refund_micros,
              COALESCE(sum(proceeds_amount_micros), 0)::text AS proceeds_micros
         FROM subscription_transactions
        WHERE currency IS NOT NULL
        GROUP BY provider, environment, currency
        ORDER BY environment, currency, provider`
    );
    res.json({
      rows: result.rows,
      note: "Customer totals are store-confirmed. Proceeds are shown only where the store supplies them; Apple proceeds require a financial-report import."
    });
  })
);

adminSubscriberRouter.get(
  "/",
  ...secured,
  validate(listQuery, "query"),
  asyncHandler(async (req, res) => {
    const { search, limit, offset } = req.query as unknown as z.infer<typeof listQuery>;
    const values = search ? [`%${search}%`, limit, offset] : [limit, offset];
    const where = search ? "WHERE u.email ILIKE $1" : "";
    const limitParam = search ? "$2" : "$1";
    const offsetParam = search ? "$3" : "$2";
    const result = await query<{
      id: string; email: string | null; display_name: string | null; product_code: string; plan_name: string;
      interval: string; provider: string; environment: string | null; status: string; current_start: Date | null;
      current_end: Date | null; cancelled_at: Date | null; created_at: Date; updated_at: Date;
      last_event_type: string | null; last_event_at: Date | null; total_count: string;
      paid_currency: string | null; paid_micros: string | null; transaction_count: string;
    }>(
      `SELECT s.id, u.email, u.display_name, p.product_code, p.name AS plan_name, p."interval" AS "interval",
              s.provider, s.environment, s.status, s.current_start, s.current_end, s.cancelled_at,
              s.created_at, s.updated_at, event.event_type AS last_event_type,
              event.created_at AS last_event_at, money.paid_currency, money.paid_micros,
              money.transaction_count, count(*) OVER()::text AS total_count
         FROM subscriptions s
         JOIN app_users u ON u.id = s.user_id
         JOIN subscription_plans p ON p.id = s.local_plan_id
         LEFT JOIN LATERAL (
           SELECT event_type, created_at FROM store_events
            WHERE provider = s.provider AND provider_subscription_id = s.provider_subscription_id
            ORDER BY created_at DESC LIMIT 1
         ) event ON true
         LEFT JOIN LATERAL (
           SELECT CASE WHEN count(DISTINCT currency) = 1 THEN min(currency) ELSE NULL END AS paid_currency,
                  (sum(COALESCE(gross_amount_micros, 0)) - sum(COALESCE(refund_amount_micros, 0)))::text AS paid_micros,
                  count(*)::text AS transaction_count
             FROM subscription_transactions WHERE subscription_id = s.id
         ) money ON true
         ${where}
        ORDER BY s.updated_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values
    );
    res.json({
      total: Number(result.rows[0]?.total_count ?? 0),
      offset,
      subscriptions: result.rows.map((row) => ({ ...row, status_label: statusLabel(row.status, row.current_end) }))
    });
  })
);

adminSubscriberRouter.get(
  "/:id/events",
  ...secured,
  validate(idParams, "params"),
  asyncHandler(async (req, res) => {
    const subscription = await query<{ id: string; email: string | null; provider: string; provider_subscription_id: string | null }>(
      `SELECT s.id, u.email, s.provider, s.provider_subscription_id
         FROM subscriptions s JOIN app_users u ON u.id = s.user_id WHERE s.id = $1`,
      [req.params.id]
    );
    const row = subscription.rows[0];
    if (!row) throw new HttpError(404, "Subscription not found", "NOT_FOUND");
    const events = row.provider_subscription_id
      ? await query<{ id: string; event_type: string; processed_at: Date | null; created_at: Date }>(
          `SELECT id, event_type, processed_at, created_at FROM store_events
            WHERE provider = $1 AND provider_subscription_id = $2 ORDER BY created_at DESC LIMIT 100`,
          [row.provider, row.provider_subscription_id]
        )
      : { rows: [] };
    const transactions = await query<{
      id: string; provider_transaction_id: string; transaction_kind: string; currency: string | null;
      gross_amount_micros: string | null; refund_amount_micros: string | null;
      proceeds_amount_micros: string | null; purchased_at: Date | null; environment: string;
    }>(
      `SELECT id, provider_transaction_id, transaction_kind, currency, gross_amount_micros::text,
              refund_amount_micros::text, proceeds_amount_micros::text, purchased_at, environment
         FROM subscription_transactions WHERE subscription_id = $1
        ORDER BY purchased_at DESC NULLS LAST, created_at DESC LIMIT 100`,
      [row.id]
    );
    res.json({ subscription: row, events: events.rows, transactions: transactions.rows });
  })
);
