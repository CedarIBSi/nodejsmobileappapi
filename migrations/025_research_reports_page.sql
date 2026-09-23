-- Research Reports screen copy. Singleton page row, same shape as
-- thought_leadership_page (024): prose, a bulleted list in the middle of it,
-- then more prose.
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
