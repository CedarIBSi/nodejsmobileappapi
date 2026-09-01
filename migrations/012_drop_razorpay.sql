-- Removes the last of the Razorpay integration from the schema. The code side
-- went on 2026-08-31 (services/razorpay.ts, the /create + /cancel routes, the
-- webhook handler, the RAZORPAY_* env vars); this drops the columns and the
-- table those wrote to, plus the tax fields that only ever existed to compute
-- a Razorpay checkout total.
--
-- SEQUENCING: deploy the code that stops SELECTing tax_percent BEFORE running
-- this, or the running server 500s on GET /v1/subscription/plans.
--
-- DESTRUCTIVE: payment_events holds the historical Razorpay payment log. If
-- that history matters for accounting, dump it before running this:
--   pg_dump -t payment_events ibs_intelligence_news > payment_events.sql

BEGIN;

-- Fail loudly rather than quietly orphaning live Razorpay subscribers.
DO $$
DECLARE legacy integer;
BEGIN
  SELECT count(*) INTO legacy FROM subscriptions WHERE provider = 'razorpay';
  IF legacy > 0 THEN
    RAISE EXCEPTION 'Refusing to drop Razorpay support: % subscription(s) still have provider = razorpay. Migrate or archive them first.', legacy;
  END IF;
END $$;

-- 'razorpay' stops being a legal provider, and new rows must name their store.
ALTER TABLE subscriptions
  ALTER COLUMN provider DROP DEFAULT,
  DROP CONSTRAINT IF EXISTS subscriptions_provider_check;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_provider_check
    CHECK (provider IN ('apple', 'google_play'));

ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS razorpay_subscription_id,
  DROP COLUMN IF EXISTS razorpay_plan_id,
  DROP COLUMN IF EXISTS razorpay_customer_id;

-- tax_percent fed round(price_amount * (1 + tax_percent / 100)) in GET /plans.
-- The stores are the merchant of record and quote their own tax-inclusive
-- price, so both the column and that arithmetic are dead.
ALTER TABLE subscription_plans
  DROP COLUMN IF EXISTS razorpay_plan_id,
  DROP COLUMN IF EXISTS tax_percent;

DROP TABLE IF EXISTS payment_events;

COMMIT;
