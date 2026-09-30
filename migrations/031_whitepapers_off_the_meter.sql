-- White papers come off the Insights meter: they are free to read from
-- 2026-09-30. POST /v1/insights/access no longer accepts `whitepaper` and the
-- view-link mint no longer checks for a spent read.
--
-- The reads already spent on white papers this month would otherwise keep
-- counting against a reader's five for the four types that stay metered, so
-- they are removed. The CHECK is tightened to match the code, for the same
-- reason it was there in the first place: a route that still sent
-- `whitepaper` would be creating a bucket nothing reads.
DELETE FROM insight_access WHERE content_type = 'whitepaper';

ALTER TABLE insight_access
  DROP CONSTRAINT insight_access_content_type_check;
ALTER TABLE insight_access
  ADD CONSTRAINT insight_access_content_type_check CHECK (
    content_type IN ('analyst_opinion', 'leadership_interview', 'podcast', 'video')
  );
