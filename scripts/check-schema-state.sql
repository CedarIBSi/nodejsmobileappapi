-- Read-only. Run this FIRST, in pgAdmin against ibs_intelligence_news, before
-- running scripts/apply-012-013-subscriptions.sql. Nothing here changes data.
--
-- Answers the four questions that decide whether the fix is safe to run:
--   1. which migrations are actually applied
--   2. who owns the tables the app writes to
--   3. whether any live subscriber still has provider = 'razorpay' (this
--      aborts migration 012 by design)
--   4. how much Razorpay payment history 012 would destroy

-- 1. Applied migrations. Expect 001-011; 012, 013 and 014 are the question.
SELECT filename, applied_at
FROM schema_migrations
ORDER BY filename;

-- 2. Table ownership. Every row should say ibs_news_api. Any that says
--    postgres (or another role) is a table the migration runner cannot ALTER,
--    which is what makes `npm run migrate` stop.
SELECT tablename, tableowner
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tableowner, tablename;

-- 3. Migration 012 refuses to run while this is above zero, on purpose - it
--    would orphan a paying subscriber. If it returns anything but 0, stop and
--    deal with those rows before going any further.
SELECT count(*) AS razorpay_subscriptions
FROM subscriptions
WHERE provider = 'razorpay';

-- 4. What 012 deletes. If this is 0, there is nothing to preserve and the
--    archive step in the apply script is a no-op. Written as a DO block so it
--    reports rather than errors when the table has already been dropped; the
--    answer appears in pgAdmin's Messages tab, not the results grid.
DO $$
DECLARE row_count bigint;
BEGIN
  IF to_regclass('public.payment_events') IS NULL THEN
    RAISE NOTICE 'payment_events: table does not exist - migration 012 has already dropped it';
  ELSE
    EXECUTE 'SELECT count(*) FROM payment_events' INTO row_count;
    RAISE NOTICE 'payment_events: % row(s) would be destroyed by migration 012', row_count;
  END IF;
END $$;
