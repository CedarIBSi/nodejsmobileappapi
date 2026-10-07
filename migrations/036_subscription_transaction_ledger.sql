-- The store-confirmed financial ledger behind the Subscribers console.
--
-- One row is one Apple transaction or Google Play order. Amounts are stored
-- in millionths of a currency unit so both Apple's milliunit prices and
-- Google's units+nanos Money values can be represented without floating
-- point arithmetic. This table is reporting only: entitlement decisions
-- continue to use subscriptions and entitlements exactly as before.
CREATE TABLE subscription_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('apple', 'google_play')),
  provider_transaction_id text NOT NULL,
  product_id text,
  environment text NOT NULL CHECK (environment IN ('sandbox', 'production')),
  transaction_kind text NOT NULL DEFAULT 'charge'
    CHECK (transaction_kind IN ('charge', 'refund')),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  gross_amount_micros bigint CHECK (gross_amount_micros IS NULL OR gross_amount_micros >= 0),
  refund_amount_micros bigint CHECK (refund_amount_micros IS NULL OR refund_amount_micros >= 0),
  proceeds_amount_micros bigint,
  tax_amount_micros bigint CHECK (tax_amount_micros IS NULL OR tax_amount_micros >= 0),
  purchased_at timestamptz,
  store_updated_at timestamptz,
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_transaction_id)
);

CREATE INDEX idx_subscription_transactions_subscription
  ON subscription_transactions(subscription_id, purchased_at DESC);
CREATE INDEX idx_subscription_transactions_user
  ON subscription_transactions(user_id, purchased_at DESC);
CREATE INDEX idx_subscription_transactions_provider_date
  ON subscription_transactions(provider, purchased_at DESC);

COMMENT ON TABLE subscription_transactions IS
  'Store-confirmed transaction snapshots for reporting; never used to grant or deny access.';
COMMENT ON COLUMN subscription_transactions.gross_amount_micros IS
  'Customer total in millionths of the currency unit; null when the store did not supply it.';
COMMENT ON COLUMN subscription_transactions.proceeds_amount_micros IS
  'Developer proceeds where the store supplies them; not inferred from catalogue prices.';
