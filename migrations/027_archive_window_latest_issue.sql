-- The archive window must never open on an empty shelf.
--
-- 026 started a monthly subscriber's window at the month they joined. That is
-- wrong whenever the current month's edition has not been published yet:
-- someone subscribing on 2 September, with August the newest issue out, would
-- see the whole archive locked and nothing to read until September shipped.
--
-- The window therefore starts at the EARLIER of the joining month and the
-- newest published issue at the moment they subscribed, so a new subscriber
-- always gets at least the latest edition that exists.
--
-- That value has to be frozen at purchase, not recomputed on every read. If it
-- were derived live it would move forward the moment September published -
-- re-locking the August issue the subscriber had already been reading, which
-- is the exact "window slides forward and takes content back" failure 026
-- existed to prevent.
--
-- Rows written before this migration keep a NULL here and fall back to the
-- month of first_subscribed_at, which is precisely their behaviour today; the
-- window can only ever widen, never narrow.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS archive_from_month text
  CONSTRAINT subscriptions_archive_from_month_format
    CHECK (archive_from_month IS NULL OR archive_from_month ~ '^[0-9]{4}-[0-9]{2}$');

COMMENT ON COLUMN subscriptions.archive_from_month IS
  'Frozen first journal issue month (YYYY-MM) this subscription may read; NULL falls back to the month of first_subscribed_at. Only ever moves earlier.';

-- An issue''s month as YYYY-MM, matching journalIssueMonth() in
-- src/lib/journal-archive.ts exactly - including the fallback to December for
-- an unreadable month name, which is the generous reading within a year and
-- still correct across years. The two must stay in step: this one finds the
-- newest issue when a window is frozen, the TypeScript one decides whether an
-- individual issue sits inside that window.
CREATE OR REPLACE FUNCTION journal_issue_month(p_month text, p_year text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN btrim(coalesce(p_year, '')) ~ '^[0-9]{4}$'
      AND btrim(p_year)::integer BETWEEN 1900 AND 2200 THEN
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
  'Journal issue month as YYYY-MM; mirrors journalIssueMonth() in src/lib/journal-archive.ts.';
