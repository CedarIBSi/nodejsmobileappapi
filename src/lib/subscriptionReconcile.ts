import type { PoolClient } from "pg";
import { HttpError } from "./errors.js";

export type StoreProvider = "google_play" | "apple";

/**
 * Statuses that keep the 'premium_news' entitlement granted.
 *
 * The two stores spell their states differently and both spellings have to
 * appear here. Google says 'in_grace_period', Apple says 'billing_grace_period'
 * (see GoogleSubscriptionState and AppleSubscriptionState). Both mean the same
 * thing - the card failed and the store is still retrying - and in both the
 * subscriber is still a paying customer the store expects to keep access.
 * Apple's spelling was missing here, so every iOS subscriber whose payment
 * hiccuped was locked out instantly while the account screen told them to
 * update their payment method to keep the access they had already lost.
 *
 * 'canceled' belongs here, which reads wrong at first glance. In the stores'
 * model cancelling only switches auto-renew off: the subscription stays live
 * until the period the user already paid for runs out. Dropping the
 * entitlement on the cancellation notice would take access away the moment
 * someone cancels on day two of a paid month - money taken, service withdrawn.
 * Expiry needs no special case here because the entitlement carries ends_at =
 * current_end and every read filters on it, so access lapses on its own.
 *
 * 'revoked' is deliberately absent: that is a refund or chargeback, where
 * access is supposed to stop immediately. So are 'expired', 'on_hold' and
 * 'paused', none of which are paid-up states.
 *
 * 'trialing' is not emitted by either store today - Play reports a trial as
 * 'active'. It is kept because it can only ever grant, never deny.
 */
const activeStatuses = new Set([
  "active",
  "trialing",
  "in_grace_period",
  "billing_grace_period",
  "canceled"
]);

/**
 * States from which the store will never take money again.
 *
 * The question is about billing, not about access, and the two part company at
 * 'canceled'. A cancelled subscription still grants access - that is why it
 * appears in activeStatuses above - but auto-renew is off and no further charge
 * will ever be raised. An earlier version of this list reasoned about the paid
 * period instead and left 'canceled' out, which meant a reader who cancelled in
 * the store, exactly as the app told them to, came back and was refused again
 * with the same message. There was nothing further they could do.
 *
 * Written as the negative set on purpose. Callers ask for the complement, so a
 * status nobody anticipated - a new store enum, a typo, Google's 'unspecified' -
 * counts as still billable. For account deletion that is the safe direction:
 * refusing to delete an account that had nothing running is a support ticket,
 * while deleting one that is still being charged strands a paying customer with
 * no account and no way to cancel.
 */
export const nonBillableStoreStatuses = [
  "canceled",
  "expired",
  "pending_purchase_canceled",
  "revoked"
] as const;

/**
 * Billable statuses that keep their claim on a reader after `current_end` has
 * passed, because the store can still restart the charging it paused.
 *
 * Everything else billable is only billable while its paid period is running.
 * That distinction matters because a subscription row is not self-healing:
 * refreshLapsedSubscription re-asks the store about the newest row only, so a
 * purchase that lapsed without its final webhook keeps whatever status it last
 * had, forever. A tester's account accumulates a row per purchase and several
 * end up frozen at 'active' with an expiry days in the past - live-looking rows
 * for subscriptions Play finished with long ago.
 *
 * Reading those as billable is what made account deletion impossible: the
 * account screen shows the newest row and says there is nothing to cancel,
 * while a guard that scans every row keeps finding one. No cancellation can
 * clear a row the store will never mention again.
 *
 * Grace/retry, 'on_hold' and 'paused' genuinely outlive their period: the
 * stores can still retry or resume billing after the last paid expiry, so they
 * are named here and go on blocking.
 */
export const billableAfterPeriodEndStatuses = [
  "billing_grace_period",
  "billing_retry",
  "in_grace_period",
  "on_hold",
  "paused"
] as const;

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
  const upserted = await client.query<{ id: string; user_id: string }>(
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
     RETURNING id, user_id`,
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
  const upsertedRow = upserted.rows[0]!;

  // The conflict target is (provider, provider_subscription_id) alone, so a
  // purchase token that already belongs to someone else lands on their row and
  // `DO UPDATE` leaves its user_id untouched. Without this check the caller
  // would then be handed that row - and the entitlement write below would
  // attach their user_id to another account's subscription.
  //
  // Only POST /verify-purchase can reach this: the webhook and refresh paths
  // both take userId from the row they just read. A purchase token is a bearer
  // credential for exactly one account, so a mismatch is either a copied token
  // or a bug, and neither should be reconciled.
  if (upsertedRow.user_id !== input.userId) {
    throw new HttpError(
      409,
      "This purchase is already linked to another account",
      "PURCHASE_ALREADY_LINKED"
    );
  }

  const subscriptionId = upsertedRow.id;

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
