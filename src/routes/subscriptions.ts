import { Router } from "express";
import { z } from "zod";
import { query, transaction } from "../db/pool.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/errors.js";
import { isStaffRole } from "../lib/entitlement.js";
import { privateRoute } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { getGoogleSubscription } from "../services/googlePlay.js";
import { getAppleSubscription } from "../services/appStore.js";
import { isProductCode, type ProductCode, products } from "../lib/catalogue.js";
import { notifySubscriptionChange } from "../lib/purchaseEmail.js";
import { reconcileStoreSubscription, type StoreProvider } from "../lib/subscriptionReconcile.js";
import { refreshLapsedSubscription } from "../lib/subscriptionRefresh.js";

export const subscriptionRouter = Router();
const verifyPurchaseSchema = z.discriminatedUnion("platform", [
  z.object({
    platform: z.literal("android"),
    plan_id: z.uuid(),
    product_id: z.string().min(1),
    purchase_token: z.string().min(1)
  }),
  z.object({
    platform: z.literal("ios"),
    plan_id: z.uuid(),
    product_id: z.string().min(1),
    transaction_id: z.string().min(1)
  })
]);

const statusColumns = `s.id, s.provider, s.status, s.current_start, s.current_end, s.cancelled_at,
            p.id AS plan_id, p.code AS plan_code, p.name AS plan_name, p.product_code,
            p.apple_product_id, p.google_product_id`;

/** Products in the order the app lists them; within a product, monthly before yearly. */
const planOrderSql = `ORDER BY array_position(ARRAY['journal_india', 'journal_global', 'journal_all'], product_code),
            CASE lower("interval") WHEN 'monthly' THEN 0 ELSE 1 END`;

subscriptionRouter.get("/plans", asyncHandler(async (_req, res) => {
  const result = await query<{ product_code: ProductCode } & Record<string, unknown>>(
    // No tax fields: the stores are the merchant of record and quote their own
    // tax-inclusive price (a Rs 99 base plan bills as Rs 120 in India). The old
    // tax_percent/total_amount pair was Razorpay-era arithmetic that matched
    // neither the stored amount nor the amount actually charged. `price_amount`
    // is a reference figure only - the app displays the store's price.
    `SELECT id, code, name, product_code, price_amount, currency, "interval",
            apple_product_id, google_product_id
     FROM subscription_plans WHERE status = 'active' ${planOrderSql}`
  );
  // The product's name and editions ride with every plan so the app can
  // group monthly and yearly under one heading without knowing the catalogue.
  res.json({
    plans: result.rows.map((plan) => ({
      ...plan,
      editions: isProductCode(plan.product_code) ? products[plan.product_code].editions : [],
      product_name: isProductCode(plan.product_code) ? products[plan.product_code].name : plan.name
    }))
  });
}));

subscriptionRouter.get("/status", ...privateRoute, asyncHandler(async (req, res) => {
  // Backstop for a renewal the store never told us about: if the stored period
  // has lapsed, ask the store before answering. Best-effort and self-limiting -
  // see refreshLapsedSubscription. Without this, a missed webhook locks out a
  // subscriber who is still being charged.
  await refreshLapsedSubscription(req.appUser!.id);

  const result = await query(
    `SELECT ${statusColumns},
            EXISTS (
              SELECT 1 FROM entitlements e WHERE e.subscription_id = s.id
                AND e.status = 'active' AND (e.ends_at IS NULL OR e.ends_at > now())
            ) AS has_active_entitlement
     FROM subscriptions s JOIN subscription_plans p ON p.id = s.local_plan_id
     WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [req.appUser!.id]
  );

  // Staff hold access through their role, not a purchase, so there is no
  // subscription row to find and this endpoint used to answer "none" while
  // every content gate let them through - an employee with working access being
  // told they had none. Reported the same way /v1/entitlements/me reports staff
  // access: as a record of the ordinary shape, so clients need no special case.
  //
  // `staff` is not a store status and no reconciliation path can produce it, so
  // a client that does not recognise it falls through to its own default rather
  // than misreading it as an active paid plan. Provider is null deliberately:
  // the app keys "Manage subscription" off google_play/apple, and there is
  // nothing for staff to manage in a store.
  const subscription =
    result.rows[0] ??
    (isStaffRole(req.appUser!.role)
      ? {
          id: `staff:${req.appUser!.id}`,
          provider: null,
          status: "staff",
          current_start: null,
          current_end: null,
          cancelled_at: null,
          plan_id: null,
          plan_code: null,
          plan_name: null,
          product_code: null,
          apple_product_id: null,
          google_product_id: null,
          has_active_entitlement: true
        }
      : null);

  res.json({ subscription });
}));

// Purchases and cancellations both live in the stores: buying happens through
// the native Play Billing / StoreKit sheet, cancelling through the store's own
// subscription center (the app deep-links there). This API has no checkout
// endpoint of its own by design.

// Called right after the app's native Play Billing / StoreKit purchase flow
// completes. The purchase token / transaction id the app reports is only a
// pointer - Google/Apple are asked directly for the purchase's real state
// before anything is granted, exactly like the webhook handlers below do for
// renewals. Reused by both the first purchase and, if the app calls it again
// after a `restorePurchases()`, an already-owned one (upserts either way).
subscriptionRouter.post(
  "/verify-purchase",
  ...privateRoute,
  validate(verifyPurchaseSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof verifyPurchaseSchema>;
    const planResult = await query<{
      apple_product_id: string | null;
      google_product_id: string | null;
      id: string;
    }>(
      "SELECT id, apple_product_id, google_product_id FROM subscription_plans WHERE id = $1 AND status = 'active'",
      [body.plan_id]
    );
    const plan = planResult.rows[0];
    if (!plan) throw new HttpError(404, "Subscription plan not found", "PLAN_NOT_FOUND");

    let provider: StoreProvider;
    let providerSubscriptionId: string;
    let status: string;
    let currentStart: Date | null;
    let currentEnd: Date | null;
    let environment: "sandbox" | "production";

    if (body.platform === "android") {
      if (plan.google_product_id !== body.product_id) {
        throw new HttpError(400, "Product does not match the selected plan", "PRODUCT_MISMATCH");
      }
      const summary = await getGoogleSubscription(body.purchase_token);
      if (summary.productId && summary.productId !== body.product_id) {
        throw new HttpError(400, "Purchase does not match the requested product", "PRODUCT_MISMATCH");
      }
      provider = "google_play";
      providerSubscriptionId = summary.purchaseToken;
      status = summary.state;
      currentStart = summary.currentStart;
      currentEnd = summary.currentEnd;
      environment = summary.isTestPurchase ? "sandbox" : "production";
    } else {
      if (plan.apple_product_id !== body.product_id) {
        throw new HttpError(400, "Product does not match the selected plan", "PRODUCT_MISMATCH");
      }
      const summary = await getAppleSubscription(body.transaction_id);
      if (summary.productId && summary.productId !== body.product_id) {
        throw new HttpError(400, "Purchase does not match the requested product", "PRODUCT_MISMATCH");
      }
      provider = "apple";
      providerSubscriptionId = summary.originalTransactionId;
      status = summary.state;
      currentStart = null;
      currentEnd = summary.currentEnd;
      environment = summary.environment;
    }

    // What we knew of this subscription before the reconcile, so the email
    // below goes out once per purchase and not on every call. The app verifies
    // a purchase twice within a second - once from the purchase event and once
    // from its quiet restore - and again on every later restore; only the call
    // that first records the plan, or records a different plan than before,
    // is a purchase the reader needs telling about (see emailKindFor).
    const before = await query<{ local_plan_id: string; status: string }>(
      `SELECT local_plan_id, status FROM subscriptions WHERE provider = $1 AND provider_subscription_id = $2`,
      [provider, providerSubscriptionId]
    );
    const previous = before.rows[0] ?? null;

    const subscriptionId = await transaction((client) =>
      reconcileStoreSubscription(client, {
        cancelledAt: status === "revoked" || status === "canceled" ? new Date() : null,
        currentEnd,
        currentStart,
        environment,
        planId: plan.id,
        provider,
        providerSubscriptionId,
        status,
        userId: req.appUser!.id
      })
    );

    const result = await query(
      `SELECT ${statusColumns},
              EXISTS (
                SELECT 1 FROM entitlements e WHERE e.subscription_id = s.id
                  AND e.status = 'active' AND (e.ends_at IS NULL OR e.ends_at > now())
              ) AS has_active_entitlement
       FROM subscriptions s JOIN subscription_plans p ON p.id = s.local_plan_id
       WHERE s.id = $1`,
      [subscriptionId]
    );
    res.status(201).json({ subscription: result.rows[0] });

    // After the response: the reader is already subscribed, and the mail can
    // take a few seconds on a slow relay that the purchase screen should not
    // wait for. Never throws - see notifySubscriptionChange.
    void notifySubscriptionChange(
      {
        currentEnd,
        environment,
        planId: plan.id,
        previousPlanId: previous?.local_plan_id ?? null,
        previousStatus: previous?.status ?? null,
        provider,
        status,
        subscriptionId,
        userId: req.appUser!.id
      },
      req.log
    );
  })
);
