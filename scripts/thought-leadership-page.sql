-- Thought Leadership: create the page table and load its content.
-- Run by hand in pgAdmin against the Azure database, as one buffer.
--
-- Safe to run more than once: CREATE TABLE IF NOT EXISTS, and the INSERT is
-- ON CONFLICT DO NOTHING so a second run cannot overwrite copy edited since.
--
-- IMPORTANT: the screen stays on its error state until the API change that
-- serves /v1/thought-leadership is deployed. Running this first is harmless.

BEGIN;

CREATE TABLE IF NOT EXISTS thought_leadership_page (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  title text NOT NULL,
  -- Paragraphs above the list, ending on the line that introduces it.
  intro text NOT NULL,
  -- ["Expert-led webinars", ...]
  portfolio jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Paragraphs below the list.
  body text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO thought_leadership_page (id, title, intro, portfolio, body)
VALUES (
  1,
  $title$Thought Leadership$title$,
  $intro$IBSi’s thought leadership reflects over 30 years of global engagement in banking and financial technology.

Our portfolio includes:$intro$,
  $portfolio$[
  "Expert-led webinars",
  "Insightful whitepapers",
  "Detailed case studies"
]$portfolio$::jsonb,
  $body$IBSi has produced over 50 whitepapers across key domains including Analytics, AI, BaaS, Big Data, Cloud, Core Banking, Digital Banking, Islamic Banking, Lending, Open Banking, Payments, RegTech, RPA, SaaS, and Transaction Banking.

Each publication is designed to position organizations as category leaders while delivering substantive, practitioner-focused insight.$body$
)
ON CONFLICT (id) DO NOTHING;

-- Tell the migration runner this file has already been applied.
INSERT INTO schema_migrations (filename)
VALUES ('024_thought_leadership_page.sql')
ON CONFLICT (filename) DO NOTHING;

-- Read this back before committing: two intro paragraphs, three list items,
-- two closing paragraphs.
SELECT
  title,
  length(intro)                 AS intro_chars,
  jsonb_array_length(portfolio) AS portfolio_count,
  length(body)                  AS body_chars
FROM thought_leadership_page
WHERE id = 1;

COMMIT;
