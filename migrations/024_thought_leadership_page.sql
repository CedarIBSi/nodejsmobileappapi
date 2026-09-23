-- Thought Leadership screen copy. Singleton page row, following
-- fintech_lab_page (021) and advisory_page (023).
--
-- Split into intro/portfolio/body because the bulleted list sits in the
-- middle of the prose rather than after it: the paragraphs above end on the
-- line that introduces the list, and two more follow it.
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
