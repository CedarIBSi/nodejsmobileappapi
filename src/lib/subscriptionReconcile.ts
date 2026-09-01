import type { PoolClient } from "pg";

export type StoreProvider = "google_play" | "apple";

// Statuses that keep the 'premium_news' entitlement granted. Anything else
// (cancelled, expired, revoked, on_hold, paused) drops it.
const activeStatuses = new Set(["active", "trialing", "in_grace_period"]);

export type ReconcileStoreSubscriptionInput = {
  cancelledAt: Date | null;
  currentEnd: Date | null;
  currentStart: Date | null;
  environment: "sandbox" | "production";
  planId: string;
  provider: StoreProvider;
  /**
   * The identifier that stays stable across renewals - Android's original/
   * linked purchase token, iOS's original transaction id. Never the
   * per-renewal one; that would fragment a single subscription into many
   * rows under the (provider, provider_subscription_id) unique index.
   */
  providerSubscriptionId: string;
  status: string;
  userId: string;
};

/**
 * Upserts a `subscriptions` row for a Google Play or Apple purchase and
 * keeps the shared `entitlements` table in sync - the same two-step every
 * provider needs, used by both POST /verify-purchase (first purchase) and
 * the RTDN/App Store Server Notification webhooks (renewals, cancellations,
 * refunds). Must run inside the caller's `transaction()`.
 */
export async function reconcileStoreSubscription(
  client: PoolClient,
  input: ReconcileStoreSubscriptionInput
): Promise<string> {
  const upserted = await client.query<{ id: string }>(
    `INSERT INTO subscriptions
       (user_id, local_plan_id, status, provider, provider_subscription_id, environment,
        current_start, current_end, cancelled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (provider, provider_subscription_id) WHERE provider_subscription_id IS NOT NULL
     DO UPDATE SET
       status = EXCLUDED.status,
       local_plan_id = EXCLUDED.local_plan_id,
       environment = EXCLUDED.environment,
       current_start = COALESCE(EXCLUDED.current_start, subscriptions.current_start),
       current_end = COALESCE(EXCLUDED.current_end, subscriptions.current_end),
       cancelled_at = EXCLUDED.cancelled_at,
       updated_at = now()
     RETURNING id`,
    [
      input.userId,
      input.planId,
      input.status,
      input.provider,
      input.providerSubscriptionId,
      input.environment,
      input.currentStart,
      input.currentEnd,
      input.cancelledAt
    ]
  );
  const subscriptionId = upserted.rows[0]!.id;

  if (activeStatuses.has(input.status)) {
    await client.query(
      `INSERT INTO entitlements
         (user_id, subscription_id, entitlement_type, status, starts_at, ends_at, source)
       VALUES ($1, $2, 'premium_news', 'active', COALESCE($3, now()), $4, $5)
       ON CONFLICT (subscription_id, entitlement_type) DO UPDATE SET
         status = 'active', starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, updated_at = now()`,
      [input.userId, subscriptionId, input.currentStart, input.currentEnd, input.provider]
    );
  } else {
    await client.query(
      `UPDATE entitlements SET status = $2, ends_at = COALESCE(ends_at, now()), updated_at = now()
       WHERE subscription_id = $1 AND status = 'active'`,
      [subscriptionId, input.status === "paused" ? "paused" : "inactive"]
    );
  }

  return subscriptionId;
}
