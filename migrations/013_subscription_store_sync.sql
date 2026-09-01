-- Throttling column for the lapsed-subscription store refresh.
--
-- GET /v1/subscription/status re-asks the store whenever the stored period has
-- lapsed and the subscription is still in a recoverable state. That is
-- self-limiting for a healthy subscription (the refresh writes a new expiry, so
-- the staleness test stops matching) but NOT for one in account hold: Google
-- extended account hold to 60 days at I/O 2026, and for that whole time
-- current_end stays in the past while the status stays refreshable.
--
-- The app calls /status on every screen focus, so without a throttle a single
-- held subscriber would generate a Play API call per navigation for two months.
-- This column records when the store was last consulted for a subscription so
-- the refresh can rate-limit itself regardless of subscription state.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS last_store_sync_at timestamptz;

COMMENT ON COLUMN subscriptions.last_store_sync_at IS
  'When the provider store was last queried for this subscription; used to rate-limit the lapsed-period refresh.';
