-- Archive depth by plan: a yearly subscriber reads the whole journal archive,
-- a monthly subscriber reads only issues from the month they first subscribed.
--
-- The rule needs one fact the schema does not currently keep: when a user FIRST
-- paid. `entitlements.starts_at` cannot answer it - reconcileStoreSubscription
-- overwrites it with the current period's start on every renewal, so a monthly
-- subscriber's window would slide forward a month at a time and silently take
-- back issues they had already been reading.
--
-- `subscriptions.created_at` is close (the upsert conflicts on the purchase
-- token that stays stable across renewals, so the row is inserted once and
-- created_at is never touched), but it records when this API first saw the
-- purchase rather than when the store says it began. This column holds the
-- earlier of the two, is written once, and is never updated afterwards - which
-- is also what makes "cancel and resubscribe keeps the old window" fall out for
-- free: the same row, with the same frozen date, is reused.
--
-- A user who fully lapses and buys again can get a new original purchase token
-- and therefore a second row; the access check takes MIN() across all of a
-- user's subscriptions, so the earliest date still wins.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS first_subscribed_at timestamptz;

UPDATE subscriptions
  SET first_subscribed_at = LEAST(created_at, COALESCE(current_start, created_at))
  WHERE first_subscribed_at IS NULL;

ALTER TABLE subscriptions
  ALTER COLUMN first_subscribed_at SET DEFAULT now();

ALTER TABLE subscriptions
  ALTER COLUMN first_subscribed_at SET NOT NULL;

COMMENT ON COLUMN subscriptions.first_subscribed_at IS
  'When this subscription first began, frozen at insert and never updated; MIN() across a user''s rows is the start of their journal archive window.';

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_first_subscribed
  ON subscriptions(user_id, first_subscribed_at);

