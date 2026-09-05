import { query, transaction } from "../db/pool.js";
import { getAppleSubscription } from "../services/appStore.js";
import { getGoogleSubscription } from "../services/googlePlay.js";
import { reconcileStoreSubscription, type StoreProvider } from "./subscriptionReconcile.js";

/**
 * States worth re-asking the store about once the stored period has lapsed.
 * A subscription in one of these was still alive at last check, so the lapse
 * most likely means "it renewed and we were not told" rather than "it ended".
 * Terminal states are absent on purpose: once the store says expired or
 * revoked, re-fetching forever would just burn quota on a dead subscription.
 */
const refreshableStatuses = new Set([
  "active",
  "trialing",
  "in_grace_period",
  "billing_grace_period",
  "on_hold",
  "paused",
  "pending",
  // Cancelled but not yet expired. Worth one more look when the period ends,
  // because two very different things can have happened: it lapsed as
  // expected, or the user resubscribed before expiry and the store reactivated
  // the same purchase. Without this check a resubscriber silently loses access
  // at the old expiry date. Self-terminating - the answer is either 'expired'
  // or 'active', and 'expired' is not refreshable.
  "canceled"
]);

/**
 * Gap between store lookups for one subscription, derived from its own billing
 * period rather than fixed.
 *
 * A throttle is needed because a healthy subscription self-limits (the refresh
 * writes a new expiry, so the staleness test stops matching) but one in account
 * hold does not: Google extended account hold to 60 days at I/O 2026, and
 * throughout it `current_end` stays in the past while the status stays
 * refreshable. The app calls /status on every screen focus, so a fixed floor is
 * what stops that becoming one Play API call per navigation for two months.
 *
 * It has to scale with the period, though. Play compresses billing periods for
 * license testers - a monthly subscription renews every five minutes - so an
 * hour-long throttle would skip the refresh for eleven consecutive renewals and
 * strand a tester with a lapsed entitlement on a subscription that is actually
 * active. Half a period is frequent enough to catch a renewal promptly and
 * still cheap: twice per period, whatever the period is.
 */
const maxSyncIntervalMs = 60 * 60 * 1000;
const minSyncIntervalMs = 60 * 1000;

const syncIntervalMsFor = (start: Date | null, end: Date | null): number => {
  if (!start || !end) {
    return maxSyncIntervalMs;
  }

  const periodMs = end.getTime() - start.getTime();

  if (!Number.isFinite(periodMs) || periodMs <= 0) {
    return maxSyncIntervalMs;
  }

  return Math.min(maxSyncIntervalMs, Math.max(minSyncIntervalMs, periodMs / 2));
};

type StaleSubscriptionRow = {
  current_end: Date | null;
  current_start: Date | null;
  id: string;
  last_store_sync_at: Date | null;
  local_plan_id: string;
  provider: string;
  provider_subscription_id: string | null;
  status: string;
};

/**
 * Pulls the user's most recent store subscription back into sync when its
 * stored period has already lapsed.
 *
 * The webhooks (Play RTDN / App Store notifications) are the primary path for
 * renewals, but they are a delivery guarantee nobody should lean on alone:
 * they can be unconfigured, misrouted, or simply dropped. Without a backstop a
 * renewal that never arrives silently locks a paying subscriber out at period
 * end - the worst failure this system can have, because the user is still
 * being charged.
 *
 * Runs at most one store call per lapsed period: the reconcile writes the new
 * expiry, so the staleness test stops matching until that one lapses too. Any
 * failure is swallowed - this is a best-effort improvement on stored state,
 * never a reason to fail the caller's request.
 *
 * @returns true when it wrote something, so the caller can re-read.
 */
export async function refreshLapsedSubscription(userId: string): Promise<boolean> {
  const result = await query<StaleSubscriptionRow>(
    `SELECT id, local_plan_id, provider, provider_subscription_id, status,
            current_start, current_end, last_store_sync_at
       FROM subscriptions
      WHERE user_id = $1 AND provider IN ('google_play', 'apple')
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const row = result.rows[0];

  if (!row?.provider_subscription_id) return false;
  if (!refreshableStatuses.has(row.status)) return false;
  // A period still running needs no store round trip; the webhooks own that.
  if (row.current_end && row.current_end.getTime() > Date.now()) return false;
  if (
    row.last_store_sync_at &&
    Date.now() - row.last_store_sync_at.getTime() <
      syncIntervalMsFor(row.current_start, row.current_end)
  ) {
    return false;
  }

  // Stamped before the call, not after, so a store outage throttles too -
  // otherwise every failure would retry on the very next screen focus.
  await query("UPDATE subscriptions SET last_store_sync_at = now() WHERE id = $1", [row.id]);

  try {
    let provider: StoreProvider;
    let providerSubscriptionId: string;
    let status: string;
    let currentStart: Date | null = null;
    let currentEnd: Date | null;
    let environment: "sandbox" | "production";

    if (row.provider === "google_play") {
      const summary = await getGoogleSubscription(row.provider_subscription_id);
      provider = "google_play";
      providerSubscriptionId = summary.purchaseToken;
      status = summary.state;
      currentStart = summary.currentStart;
      currentEnd = summary.currentEnd;
      environment = summary.isTestPurchase ? "sandbox" : "production";
    } else {
      const summary = await getAppleSubscription(row.provider_subscription_id);
      provider = "apple";
      providerSubscriptionId = summary.originalTransactionId;
      status = summary.state;
      currentEnd = summary.currentEnd;
      environment = summary.environment;
    }

    await transaction((client) =>
      reconcileStoreSubscription(client, {
        cancelledAt: status === "revoked" || status === "canceled" ? new Date() : null,
        currentEnd,
        currentStart,
        environment,
        planId: row.local_plan_id,
        provider,
        providerSubscriptionId,
        status,
        userId
      })
    );

    return true;
  } catch (error) {
    // Deliberately non-fatal: the caller falls back to stored state, which is
    // still correct for access purposes (reads filter on ends_at).
    console.warn("[subscriptionRefresh] store refresh failed", {
      provider: row.provider,
      subscriptionId: row.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}
