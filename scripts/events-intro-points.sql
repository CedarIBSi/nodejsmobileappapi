-- Global FinTech Summits: replace the intro copy and add its bulleted list.
-- Run by hand in pgAdmin against the Azure database, as one buffer.
--
-- Safe to run more than once: ADD COLUMN IF NOT EXISTS, and the UPDATE simply
-- writes the same values again.
--
-- IMPORTANT: the app cannot show the bullets until the API change that reads
-- intro_points is deployed. Running this first is harmless - the new column is
-- just ignored by the currently deployed build.

BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM events_page WHERE id = 1) THEN
    RAISE EXCEPTION 'events_page has no row 1 - nothing to update.';
  END IF;
END
$guard$;

ALTER TABLE events_page
  ADD COLUMN IF NOT EXISTS intro_points jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN events_page.intro_points IS
  'Bulleted list shown under intro. ["Strategic insight and peer learning", ...]';

UPDATE events_page SET
  intro = $intro$IBSi hosts an annual series of seven invitation-only thought leadership summits across: London | Dubai | Bahrain | Oman | Kuwait | Mumbai | Singapore

These high-level forums convene senior banking executives, technology leaders, and industry experts. Renowned for substantive, insight-driven discussions, IBSi Summits feature distinguished panelists moderated by IBSi leadership. Since inception, IBSi has delivered over 50 summits, engaging 55+ panelist firms and 45+ sponsors.

For participants, these forums provide:$intro$,
  intro_points = $points$[
  "Strategic insight and peer learning",
  "Brand positioning opportunities",
  "High-value executive networking",
  "Meaningful engagement with prospective clients"
]$points$::jsonb
WHERE id = 1;

-- Tell the migration runner this file has already been applied.
INSERT INTO schema_migrations (filename)
VALUES ('022_events_intro_points.sql')
ON CONFLICT (filename) DO NOTHING;

-- Read this back before committing: three paragraphs, four bullets.
SELECT
  length(intro)                     AS intro_chars,
  jsonb_array_length(intro_points)  AS point_count
FROM events_page
WHERE id = 1;

COMMIT;
