import crypto from "node:crypto";
import { Router } from "express";
import { transaction } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { getGoogleOrder, getGoogleSubscription, verifyPubSubPushToken } from "../services/googlePlay.js";
import { decodeAppleTransaction, mapAppleStatus, verifyAppleNotification } from "../services/appStore.js";
import { notifySubscriptionChange, type SubscriptionTransition } from "../lib/purchaseEmail.js";
import { planIdForStoreProduct, reconcileStoreSubscription } from "../lib/subscriptionReconcile.js";
import { recordStoreTransaction } from "../lib/storeTransaction.js";

// What a handler's transaction hands back: the outcome for the response, and
// the row change for the email that may follow it. The email goes after the
// commit, never inside the transaction - a slow relay must not hold a row
// lock, and a mail failure must not roll back a store notification.
type WebhookOutcome = { status: "duplicate" | "ignored" | "processed"; transition?: SubscriptionTransition };

// Store webhooks only: Google Play RTDN and Apple App Store server
// notifications, both verified before anything is written.
export const webhookRouter = Router();

type GoogleDeveloperNotification = {
  subscriptionNotification?: {
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
};

// Google Play Real-time Developer Notifications arrive as a Pub/Sub push
// message: a JSON envelope whose `message.data` is the actual notification,
// base64-encoded. Authenticity comes from the OIDC bearer token Pub/Sub
// attaches to the push (verifyPubSubPushToken), not a body signature - there
// is no HMAC here, so this only needs the raw body for JSON parsing
// consistency with the rest of this router, not for verification.
webhookRouter.post("/google-play", asyncHandler(async (req, res) => {
  await verifyPubSubPushToken(req.header("authorization"));

  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Raw webhook body required", "INVALID_BODY");
  let envelope: { message?: { data?: string; messageId?: string } };
  try {
    envelope = JSON.parse(req.body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON payload", "INVALID_BODY");
  }

  const message = envelope.message;
  if (!message?.data) {
    res.json({ received: true, status: "ignored" });
    return;
  }

  let notification: GoogleDeveloperNotification;
  try {
    notification = JSON.parse(Buffer.from(message.data, "base64").toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid notification payload", "INVALID_BODY");
  }

  const purchaseToken = notification.subscriptionNotification?.purchaseToken ?? null;
  // Pub/Sub's own delivery id is a reasonable idempotency key - it can
  // redeliver the same message, but never issues a fresh id for a retry.
  const eventId = message.messageId ?? crypto.randomUUID();
  const eventType = String(notification.subscriptionNotification?.notificationType ?? "unknown");

  const outcome = await transaction<WebhookOutcome>(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO store_events (provider, provider_event_id, event_type, provider_subscription_id, payload_json)
       VALUES ('google_play', $1, $2, $3, $4::jsonb)
       ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [eventId, eventType, purchaseToken, JSON.stringify(notification)]
    );
    if (!inserted.rowCount) return { status: "duplicate" };
    let transition: SubscriptionTransition | undefined;

    if (purchaseToken) {
      // Only a purchase already confirmed through POST /verify-purchase can
      // be matched to a user - Google's notification carries no app user
      // identifier of its own. A notification arriving first (a race with
      // verify-purchase, or for a purchase this backend never saw) is
      // recorded in store_events for later reconciliation, not dropped.
      const existing = await client.query<{ id: string; local_plan_id: string; status: string; user_id: string }>(
        `SELECT id, user_id, local_plan_id, status FROM subscriptions
         WHERE provider = 'google_play' AND provider_subscription_id = $1 FOR UPDATE`,
        [purchaseToken]
      );
      const local = existing.rows[0];

      if (local) {
        await client.query("UPDATE store_events SET user_id = $2 WHERE id = $1", [
          inserted.rows[0]!.id,
          local.user_id
        ]);
        // Re-fetched rather than trusting the notification's own fields -
        // same "treat it as a signal to look up the real state" approach
        // getGoogleSubscription documents.
        const summary = await getGoogleSubscription(purchaseToken);
        // The product Play now reports, in case the reader changed plan in
        // the Play Store rather than in the app; the stored plan otherwise.
        const planId =
          (await planIdForStoreProduct(client, "google_play", summary.productId)) ?? local.local_plan_id;
        const environment = summary.isTestPurchase ? "sandbox" : "production";
        await reconcileStoreSubscription(client, {
          cancelledAt: summary.state === "canceled" ? new Date() : null,
          currentEnd: summary.currentEnd,
          currentStart: summary.currentStart,
          environment,
          planId,
          provider: "google_play",
          providerSubscriptionId: purchaseToken,
          status: summary.state,
          userId: local.user_id
        });
        if (summary.latestOrderId) {
          try {
            const order = await getGoogleOrder(summary.latestOrderId);
            await recordStoreTransaction(client, {
              currency: order.currency,
              environment,
              grossAmountMicros: order.grossAmountMicros,
              proceedsAmountMicros: order.proceedsAmountMicros,
              productId: summary.productId,
              provider: "google_play",
              providerTransactionId: order.orderId,
              purchasedAt: order.purchasedAt,
              rawSummary: order.raw,
              refundAmountMicros: order.refundAmountMicros,
              storeUpdatedAt: order.storeUpdatedAt,
              subscriptionId: local.id,
              taxAmountMicros: order.taxAmountMicros,
              transactionKind: order.transactionKind,
              userId: local.user_id
            });
          } catch (error) {
            req.log.warn({ err: error, order_id: summary.latestOrderId }, "Google order accounting lookup failed");
          }
        }
        transition = {
          currentEnd: summary.currentEnd,
          environment,
          planId,
          previousPlanId: local.local_plan_id,
          previousStatus: local.status,
          provider: "google_play",
          status: summary.state,
          subscriptionId: local.id,
          userId: local.user_id
        };
      }
    }

    await client.query("UPDATE store_events SET processed_at = now() WHERE id = $1", [inserted.rows[0]!.id]);
    return { status: "processed", transition };
  });

  res.json({ received: true, status: outcome.status });
  if (outcome.transition) void notifySubscriptionChange(outcome.transition, req.log);
}));

// App Store Server Notifications V2 post a single top-level `signedPayload`
// JWS. verifyAppleNotification checks Apple's signature chain (using the
// root certificates in APPLE_ROOT_CERTS_DIR) before any of it is trusted.
webhookRouter.post("/apple", asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Raw webhook body required", "INVALID_BODY");
  let envelope: { signedPayload?: string };
  try {
    envelope = JSON.parse(req.body.toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON payload", "INVALID_BODY");
  }
  if (!envelope.signedPayload) throw new HttpError(400, "signedPayload required", "INVALID_BODY");

  const notification = await verifyAppleNotification(envelope.signedPayload).catch(() => {
    throw new HttpError(401, "Invalid Apple notification signature", "INVALID_SIGNATURE");
  });

  const signedTransactionInfo = notification.data?.signedTransactionInfo;
  const decodedTransaction = signedTransactionInfo
    ? await decodeAppleTransaction(signedTransactionInfo)
    : null;
  const originalTransactionId = decodedTransaction?.originalTransactionId ?? null;
  // notificationUUID is Apple's own idempotency key for this delivery.
  const eventId =
    notification.notificationUUID ?? crypto.createHash("sha256").update(req.body).digest("hex");
  const eventType = String(notification.notificationType ?? "unknown");

  const outcome = await transaction<WebhookOutcome>(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO store_events (provider, provider_event_id, event_type, provider_subscription_id, payload_json)
       VALUES ('apple', $1, $2, $3, $4::jsonb)
       ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`,
      [eventId, eventType, originalTransactionId, JSON.stringify(notification)]
    );
    if (!inserted.rowCount) return { status: "duplicate" };
    let transition: SubscriptionTransition | undefined;

    if (originalTransactionId && notification.data?.status !== undefined) {
      const existing = await client.query<{ id: string; local_plan_id: string; status: string; user_id: string }>(
        `SELECT id, user_id, local_plan_id, status FROM subscriptions
         WHERE provider = 'apple' AND provider_subscription_id = $1 FOR UPDATE`,
        [originalTransactionId]
      );
      const local = existing.rows[0];

      if (local) {
        await client.query("UPDATE store_events SET user_id = $2 WHERE id = $1", [
          inserted.rows[0]!.id,
          local.user_id
        ]);
        const state = mapAppleStatus(notification.data.status);
        const currentEnd = decodedTransaction?.expiresDate ? new Date(decodedTransaction.expiresDate) : null;
        const environment = notification.data.environment === "Production" ? "production" : "sandbox";
        // Within one subscription group Apple moves a reader between our
        // products on its own and reports the new product id here.
        const planId =
          (await planIdForStoreProduct(client, "apple", decodedTransaction?.productId)) ?? local.local_plan_id;
        await reconcileStoreSubscription(client, {
          cancelledAt: state === "revoked" ? new Date() : null,
          currentEnd,
          currentStart: null,
          environment,
          planId,
          provider: "apple",
          providerSubscriptionId: originalTransactionId,
          status: state,
          userId: local.user_id
        });
        if (decodedTransaction?.transactionId) {
          const priceMicros = decodedTransaction.price !== undefined
            ? BigInt(decodedTransaction.price) * 1000n
            : null;
          const revoked = Boolean(decodedTransaction.revocationDate);
          await recordStoreTransaction(client, {
            currency: decodedTransaction.currency?.toUpperCase() ?? null,
            environment,
            grossAmountMicros: priceMicros,
            proceedsAmountMicros: null,
            productId: decodedTransaction.productId ?? null,
            provider: "apple",
            providerTransactionId: decodedTransaction.transactionId,
            purchasedAt: decodedTransaction.purchaseDate ? new Date(decodedTransaction.purchaseDate) : null,
            rawSummary: {
              currency: decodedTransaction.currency ?? null,
              price_micros: priceMicros?.toString() ?? null,
              revoked,
              transaction_reason: decodedTransaction.transactionReason ?? null
            },
            refundAmountMicros: revoked ? priceMicros : null,
            storeUpdatedAt: decodedTransaction.signedDate ? new Date(decodedTransaction.signedDate) : null,
            subscriptionId: local.id,
            taxAmountMicros: null,
            transactionKind: revoked ? "refund" : "charge",
            userId: local.user_id
          });
        }
        transition = {
          currentEnd,
          environment,
          planId,
          previousPlanId: local.local_plan_id,
          previousStatus: local.status,
          provider: "apple",
          status: state,
          subscriptionId: local.id,
          userId: local.user_id
        };
      }
    }

    await client.query("UPDATE store_events SET processed_at = now() WHERE id = $1", [inserted.rows[0]!.id]);
    return { status: "processed", transition };
  });

  res.json({ received: true, status: outcome.status });
  if (outcome.transition) void notifySubscriptionChange(outcome.transition, req.log);
}));
