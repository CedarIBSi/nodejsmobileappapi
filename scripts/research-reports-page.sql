-- Research Reports: create the page table and load its content.
-- Run by hand in pgAdmin against the Azure database, as one buffer.
--
-- Safe to run more than once: CREATE TABLE IF NOT EXISTS, and the INSERT is
-- ON CONFLICT DO NOTHING so a second run cannot overwrite copy edited since.
--
-- IMPORTANT: the screen stays on its error state until the API change that
-- serves /v1/research-reports is deployed. Running this first is harmless.

BEGIN;

CREATE TABLE IF NOT EXISTS research_reports_page (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  title text NOT NULL,
  -- Paragraphs above the list, ending on the line that introduces it. The
  -- domain line keeps its pipes: it is one line of copy, not a list.
  intro text NOT NULL,
  -- ["Detailed system and vendor profiles", ...]
  deliverables jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Paragraphs below the list.
  body text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO research_reports_page (id, title, intro, deliverables, body)
VALUES (
  1,
  $title$Research Reports$title$,
  $intro$IBSi covers over 5,000 global technology vendors—the most extensive coverage in the sector.

Our research library comprises more than 10,000 pages of in-depth analysis across major banking and financial technology domains, including:

Core Banking | AI in Banking | Digital Lending | Payments | Transaction Banking | Treasury | Wealth Management | and more

Deliverables include:$intro$,
  $deliverables$[
  "Detailed system and vendor profiles",
  "Use-case repositories",
  "Market intelligence reports",
  "Annual rankings and leaderboards"
]$deliverables$::jsonb,
  $body$Reports are available for online purchase and download, enabling teams to share insights internally and accelerate strategic decision-making.$body$
)
ON CONFLICT (id) DO NOTHING;

-- Tell the migration runner this file has already been applied.
INSERT INTO schema_migrations (filename)
VALUES ('025_research_reports_page.sql')
ON CONFLICT (filename) DO NOTHING;

-- Read this back before committing: four intro paragraphs, four deliverables.
SELECT
  title,
  length(intro)                    AS intro_chars,
  jsonb_array_length(deliverables) AS deliverable_count,
  length(body)                     AS body_chars
FROM research_reports_page
WHERE id = 1;

COMMIT;
