-- Advisory Services: create the page table and load its content.
-- Run by hand in pgAdmin against the Azure database, as one buffer.
--
-- Safe to run more than once: CREATE TABLE IF NOT EXISTS, and the INSERT is
-- ON CONFLICT DO NOTHING so a second run cannot overwrite copy edited since.
--
-- IMPORTANT: the screen stays on its error state until the API change that
-- serves /v1/advisory is deployed. Running this first is harmless.

BEGIN;

CREATE TABLE IF NOT EXISTS advisory_page (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  title text NOT NULL,
  intro text NOT NULL,
  -- [{ "title": "New Markets", "items": ["Entry Strategy", ...] }]
  programmes jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO advisory_page (id, title, intro, programmes)
VALUES (
  1,
  $title$Advisory Services$title$,
  $intro$The global FinTech ecosystem is diverse and fast-moving, with firms pursuing multiple use cases and growth pathways. IBSi has advised dozens of organizations, supporting market entry strategies across more than 80 countries.

Typical fast-track advisory programs include:$intro$,
  $programmes$[
  {
    "title": "New Markets",
    "items": [
      "Market & Opportunity Assessment",
      "Entry Strategy",
      "Partner Identification"
    ]
  },
  {
    "title": "Growth Strategy",
    "items": [
      "Corporate Strategy",
      "Balanced Scorecard Design & Execution",
      "Sales Excellence"
    ]
  },
  {
    "title": "Product Strategy",
    "items": [
      "Product Diagnostic",
      "Product Roadmap Development",
      "Pricing Benchmarking"
    ]
  },
  {
    "title": "Due Diligence",
    "items": [
      "Target Identification",
      "Commercial & Strategic Due Diligence"
    ]
  }
]$programmes$::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- Tell the migration runner this file has already been applied.
INSERT INTO schema_migrations (filename)
VALUES ('023_advisory_page.sql')
ON CONFLICT (filename) DO NOTHING;

-- Read this back before committing: one row, two paragraphs, four programmes.
SELECT
  title,
  length(intro)                  AS intro_chars,
  jsonb_array_length(programmes) AS programme_count
FROM advisory_page
WHERE id = 1;

COMMIT;
