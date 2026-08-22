import crypto from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { transaction } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";

type Entity = Record<string, unknown>;
type RazorpayEvent = {
  event?: string;
  created_at?: number;
  payload?: {
    subscription?: { entity?: Entity };
    payment?: { entity?: Entity };
  };
};

export const webhookRouter = Router();
const handledEvents = new Set([
  "subscription.activated", "subscription.charged", "subscription.cancelled",
  "subscription.paused", "subscription.resumed", "subscription.completed", "payment.failed"
]);

function safeEqual(signature: string, expected: string) {
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

webhookRouter.post("/razorpay", asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, "Raw webhook body required", "INVALID_BODY");
  const signature = req.header("x-razorpay-signature");
  if (!signature) throw new HttpError(401, "Webhook signature missing", "INVALID_SIGNATURE");
  const expected = crypto.createHmac("sha256", config().RAZORPAY_WEBHOOK_SECRET).update(req.body).digest("hex");
  if (!safeEqual(signature, expected)) throw new HttpError(401, "Invalid webhook signature", "INVALID_SIGNATURE");

  let event: RazorpayEvent;
  try {
    event = JSON.parse(req.body.toString("utf8")) as RazorpayEvent;
  } catch {
    throw new HttpError(400, "Invalid JSON payload", "INVALID_BODY");
  }
  const eventType = event.event ?? "unknown";
  const eventId = req.header("x-razorpay-event-id") ?? crypto.createHash("sha256").update(req.body).digest("hex");
  const subscriptionEntity = event.payload?.subscription?.entity;
  const paymentEntity = event.payload?.payment?.entity;
  const subscriptionId = String(subscriptionEntity?.id ?? paymentEntity?.subscription_id ?? "") || null;
  const paymentId = String(paymentEntity?.id ?? "") || null;

  const outcome = await transaction(async (client) => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payment_events
         (razorpay_event_id, event_type, razorpay_payment_id, razorpay_subscription_id, payload_json)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (razorpay_event_id) DO NOTHING RETURNING id`,
      [eventId, eventType, paymentId, subscriptionId, JSON.stringify(event)]
    );
    if (!inserted.rowCount) return "duplicate";

    if (handledEvents.has(eventType) && subscriptionId) {
      const local = await client.query<{ id: string; user_id: string }>(
        "SELECT id, user_id FROM subscriptions WHERE razorpay_subscription_id = $1 FOR UPDATE",
        [subscriptionId]
      );
      const subscription = local.rows[0];
      if (subscription) {
        await client.query("UPDATE payment_events SET user_id = $2 WHERE id = $1", [inserted.rows[0]!.id, subscription.user_id]);
        const remoteStatus = String(subscriptionEntity?.status ?? "");
        const statusByEvent: Record<string, string> = {
          "subscription.activated": "active",
          "subscription.charged": "active",
          "subscription.cancelled": "cancelled",
          "subscription.paused": "paused",
          "subscription.resumed": "active",
          "subscription.completed": "completed"
        };
        const status = remoteStatus || statusByEvent[eventType];
        if (status) {
          await client.query(
            `UPDATE subscriptions SET status = $2, provider = 'razorpay',
               provider_subscription_id = COALESCE(provider_subscription_id, razorpay_subscription_id),
               current_start = COALESCE(to_timestamp($3), current_start),
               current_end = COALESCE(to_timestamp($4), current_end),
               cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
               updated_at = now() WHERE id = $1`,
            [subscription.id, status, subscriptionEntity?.current_start ?? null, subscriptionEntity?.current_end ?? null]
          );
        }

        if (["subscription.activated", "subscription.charged", "subscription.resumed"].includes(eventType)) {
          await client.query(
            `INSERT INTO entitlements
               (user_id, subscription_id, entitlement_type, status, starts_at, ends_at, source)
             VALUES ($1, $2, 'premium_news', 'active', COALESCE(to_timestamp($3), now()), to_timestamp($4), 'razorpay')
             ON CONFLICT (subscription_id, entitlement_type) DO UPDATE SET
               status = 'active', starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, updated_at = now()`,
            [subscription.user_id, subscription.id, subscriptionEntity?.current_start ?? null, subscriptionEntity?.current_end ?? null]
          );
        } else if (["subscription.cancelled", "subscription.paused", "subscription.completed"].includes(eventType)) {
          await client.query(
            `UPDATE entitlements SET status = $2, ends_at = COALESCE(ends_at, now()), updated_at = now()
             WHERE subscription_id = $1 AND status = 'active'`,
            [subscription.id, eventType === "subscription.paused" ? "paused" : "inactive"]
          );
        }
      }
    }
    await client.query("UPDATE payment_events SET processed_at = now() WHERE id = $1", [inserted.rows[0]!.id]);
    return "processed";
  });
  res.json({ received: true, status: outcome });
}));
