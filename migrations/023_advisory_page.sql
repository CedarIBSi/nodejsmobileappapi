-- Advisory Services screen copy. Singleton page row, same shape as
-- galaxy_page (006) and fintech_lab_page (021).
--
-- The programme items arrive pipe-separated in IBSi's copy
-- ("Entry Strategy | Partner Identification"). Stored split, because pipes
-- are a layout device from a print deck and wrap badly on a phone - the app
-- renders them as a list.
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
