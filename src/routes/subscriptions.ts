import { Router } from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { razorpay } from "../services/razorpay.js";
import { config } from "../config.js";

export const subscriptionRouter = Router();
const createSchema = z.object({ plan_id: z.uuid() });
const cancelSchema = z.object({ cancel_at_cycle_end: z.boolean().default(true) });

subscriptionRouter.get("/plans", asyncHandler(async (_req, res) => {
  const result = await query(
    `SELECT id, code, name, price_amount, currency, "interval", tax_percent,
            round(price_amount * (1 + tax_percent / 100.0))::integer AS total_amount,
            apple_product_id, google_product_id,
            (razorpay_plan_id IS NOT NULL) AS razorpay_configured
     FROM subscription_plans WHERE status = 'active' ORDER BY price_amount`
  );
  res.json({ plans: result.rows });
}));

subscriptionRouter.get("/status", ...privateRoute, asyncHandler(async (req, res) => {
  const result = await query(
    `SELECT s.id, s.provider, s.status, s.current_start, s.current_end, s.cancelled_at,
            p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
            EXISTS (
              SELECT 1 FROM entitlements e WHERE e.subscription_id = s.id
                AND e.status = 'active' AND (e.ends_at IS NULL OR e.ends_at > now())
            ) AS has_active_entitlement
     FROM subscriptions s JOIN subscription_plans p ON p.id = s.local_plan_id
     WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [req.appUser!.id]
  );
  res.json({ subscription: result.rows[0] ?? null });
}));

subscriptionRouter.post("/create", ...privateRoute, validate(createSchema), asyncHandler(async (req, res) => {
  const planResult = await query<{
    id: string; razorpay_plan_id: string | null; code: string; name: string;
  }>("SELECT id, razorpay_plan_id, code, name FROM subscription_plans WHERE id = $1 AND status = 'active'", [req.body.plan_id]);
  const plan = planResult.rows[0];
  if (!plan) throw new HttpError(404, "Subscription plan not found", "PLAN_NOT_FOUND");
  if (!plan.razorpay_plan_id) throw new HttpError(503, "Razorpay is not configured for this plan", "PLAN_NOT_CONFIGURED");

  const existing = await query<{ razorpay_customer_id: string | null }>(
    "SELECT razorpay_customer_id FROM subscriptions WHERE user_id = $1 AND razorpay_customer_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    [req.appUser!.id]
  );
  let customerId = existing.rows[0]?.razorpay_customer_id ?? null;
  if (!customerId) {
    const customer = await razorpay().customers.create({
      name: req.appUser!.display_name ?? undefined,
      email: req.appUser!.email ?? undefined,
      contact: req.appUser!.phone ?? undefined,
      notes: { app_user_id: req.appUser!.id }
    });
    customerId = customer.id;
  }

  const remote = await razorpay().subscriptions.create({
    plan_id: plan.razorpay_plan_id,
    total_count: 120,
    customer_notify: 1,
    notes: { app_user_id: req.appUser!.id, local_plan_id: plan.id }
  });
  await query(
    `INSERT INTO subscriptions
       (user_id, razorpay_customer_id, razorpay_subscription_id, razorpay_plan_id, local_plan_id,
        status, provider, provider_subscription_id, provider_customer_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'razorpay', $3, $2)`,
    [req.appUser!.id, customerId, remote.id, plan.razorpay_plan_id, plan.id, remote.status ?? "created"]
  );
  res.status(201).json({ key_id: config().RAZORPAY_KEY_ID, subscription_id: remote.id });
}));

subscriptionRouter.post("/cancel", ...privateRoute, validate(cancelSchema), asyncHandler(async (req, res) => {
  const result = await query<{ id: string; razorpay_subscription_id: string }>(
    `SELECT id, razorpay_subscription_id FROM subscriptions
     WHERE user_id = $1 AND status IN ('created','authenticated','active','pending','halted','paused')
     ORDER BY created_at DESC LIMIT 1`,
    [req.appUser!.id]
  );
  const subscription = result.rows[0];
  if (!subscription) throw new HttpError(404, "Active subscription not found", "SUBSCRIPTION_NOT_FOUND");
  const remote = await razorpay().subscriptions.cancel(subscription.razorpay_subscription_id, req.body.cancel_at_cycle_end);
  await query(
    `UPDATE subscriptions SET status = $2, cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END,
      updated_at = now() WHERE id = $1`,
    [subscription.id, remote.status ?? (req.body.cancel_at_cycle_end ? "cancel_pending" : "cancelled")]
  );
  res.json({ subscription: { id: subscription.id, status: remote.status } });
}));
