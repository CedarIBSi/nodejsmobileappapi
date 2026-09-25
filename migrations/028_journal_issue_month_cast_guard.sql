-- Removes an integer cast from journal_issue_month that can abort a purchase.
--
-- 027 guarded the year with:
--
--   WHEN btrim(p_year) ~ '^[0-9]{4}$' AND btrim(p_year)::integer BETWEEN 1900 AND 2200
--
-- which reads as "only cast once the regex has passed". PostgreSQL makes no
-- such promise: the evaluation order of AND operands is explicitly undefined,
-- and the planner is free to try the cast first. On a year like 'n/a' that
-- raises `invalid input syntax for type integer` rather than returning NULL.
--
-- Nothing triggers it today - all 156 published journals carry a clean 4-digit
-- year - but the consequence if one ever did is out of proportion to the cause.
-- The function is called from the subscriptions upsert in
-- reconcileStoreSubscription, inside the purchase transaction, so a single
-- malformed year in the journal feed would not corrupt a window: it would
-- throw, roll the transaction back, and fail every new subscription purchase
-- until someone fixed the row. A CMS typo should not be able to stop sales.
--
-- The regex already pins the value to exactly four digits, so comparing as
-- text is equivalent to comparing as a number over that range, and never
-- casts. Same results, no error path.

CREATE OR REPLACE FUNCTION journal_issue_month(p_month text, p_year text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_year, '')) ~ '^[0-9]{4}$'
      AND btrim(p_year) BETWEEN '1900' AND '2200' THEN
      btrim(p_year) || '-' || to_char(
        COALESCE(
          CASE lower(btrim(coalesce(p_month, '')))
            WHEN 'january' THEN 1 WHEN 'february' THEN 2 WHEN 'march' THEN 3
            WHEN 'april' THEN 4 WHEN 'may' THEN 5 WHEN 'june' THEN 6
            WHEN 'july' THEN 7 WHEN 'august' THEN 8 WHEN 'september' THEN 9
            WHEN 'october' THEN 10 WHEN 'november' THEN 11 WHEN 'december' THEN 12
          END,
          12
        ),
        'FM00'
      )
    ELSE NULL
  END
$$;

COMMENT ON FUNCTION journal_issue_month(text, text) IS
  'Journal issue month as YYYY-MM; mirrors journalIssueMonth() in src/lib/journal-archive.ts. Text comparison only - never casts the year.';
