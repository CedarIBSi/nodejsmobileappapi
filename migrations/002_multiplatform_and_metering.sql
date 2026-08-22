ALTER TABLE subscription_plans
  ALTER COLUMN razorpay_plan_id DROP NOT NULL,
  ADD COLUMN apple_product_id text UNIQUE,
  ADD COLUMN google_product_id text UNIQUE,
  ADD COLUMN tax_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent >= 0 AND tax_percent <= 100);

ALTER TABLE subscriptions
  ALTER COLUMN razorpay_subscription_id DROP NOT NULL,
  ALTER COLUMN razorpay_plan_id DROP NOT NULL,
  ADD COLUMN provider text NOT NULL DEFAULT 'razorpay'
    CHECK (provider IN ('razorpay', 'apple', 'google_play')),
  ADD COLUMN provider_subscription_id text,
  ADD COLUMN provider_customer_id text,
  ADD COLUMN environment text CHECK (environment IN ('sandbox', 'production'));

CREATE UNIQUE INDEX idx_subscriptions_provider_external_id
  ON subscriptions(provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

CREATE TABLE store_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('apple', 'google_play')),
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  provider_subscription_id text,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  payload_json jsonb NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX idx_store_events_subscription
  ON store_events(provider, provider_subscription_id);

CREATE TABLE news_article_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  installation_id uuid,
  news_article_id text NOT NULL,
  period_start date NOT NULL,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NOT NULL)::integer + (installation_id IS NOT NULL)::integer = 1)
);

CREATE UNIQUE INDEX idx_news_access_user_article_period
  ON news_article_access(user_id, news_article_id, period_start)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_news_access_install_article_period
  ON news_article_access(installation_id, news_article_id, period_start)
  WHERE installation_id IS NOT NULL;
CREATE INDEX idx_news_access_user_period
  ON news_article_access(user_id, period_start);
CREATE INDEX idx_news_access_install_period
  ON news_article_access(installation_id, period_start);

INSERT INTO subscription_plans
  (code, name, razorpay_plan_id, price_amount, currency, "interval", status, tax_percent)
VALUES
  ('premium_monthly', 'Premium Monthly', NULL, 9900, 'INR', 'monthly', 'draft', 18),
  ('premium_yearly', 'Premium Yearly', NULL, 40000, 'INR', 'yearly', 'draft', 18)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  price_amount = EXCLUDED.price_amount,
  currency = EXCLUDED.currency,
  "interval" = EXCLUDED."interval",
  tax_percent = EXCLUDED.tax_percent,
  updated_at = now();
