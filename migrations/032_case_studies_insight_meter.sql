-- Case Studies join the shared Insights allowance. The API accepts
-- `case_study` as a content type and its detail route requires a read to have
-- been spent, so the database constraint must accept the same value.
--
-- White papers remain free and deliberately stay outside this constraint.
ALTER TABLE insight_access
  DROP CONSTRAINT IF EXISTS insight_access_content_type_check;

ALTER TABLE insight_access
  ADD CONSTRAINT insight_access_content_type_check CHECK (
    content_type IN (
      'analyst_opinion',
      'case_study',
      'leadership_interview',
      'podcast',
      'video'
    )
  );
