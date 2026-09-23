-- Cedar-IBSi FinTech Lab screen copy, modelled on galaxy_page (006): a
-- singleton row holding the page's prose plus its structured sub-content.
--
-- Unlike galaxy_page and award_programs there is no scraper behind this one.
-- The source is cedaribsifintechlab.com, a different site from the WordPress
-- install the other seeders read, so the content is loaded here directly.
-- Bold runs in `story` use the same **marker** convention as galaxy features:
-- React Native Text cannot hold HTML, so emphasis travels as plain text.
CREATE TABLE IF NOT EXISTS fintech_lab_page (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  title text NOT NULL,
  story text NOT NULL,
  -- [{ "value": "70+", "label": "global technology companies accelerated" }]
  stats jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{ "title": "Visibility", "bullets": ["..."] }]
  benefits jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- DO NOTHING rather than DO UPDATE: re-running this must not overwrite copy
-- that has been edited in the database since.
INSERT INTO fintech_lab_page (id, title, story, stats, benefits)
VALUES (
  1,
  $title$Cedar-IBSi FinTech Lab$title$,
  $story$Founded in 2017, the **Cedar-IBSi FinTech Lab has been home to 70+ global technology companies seeking a “soft-landing” opportunity into the European, MENA and Indian markets.** The lab is the brainchild of Cedar Consulting and IBS Intelligence, and has played an active role in accelerating technology companies in areas of go-to-market, POCs with banks, knowledge, and many other strategic areas.

**Not many know FinTech the way we do.** The lab has mentored global technology companies of different shapes and sizes, each of whom have used membership benefits to learn, partner, and accelerate.$story$,
  $stats$[
  {
    "value": "25+",
    "label": "countries represented"
  },
  {
    "value": "70+",
    "label": "global technology companies accelerated"
  },
  {
    "value": "10K+",
    "label": "pages of proprietary research and use cases"
  },
  {
    "value": "70+",
    "label": "year track-record"
  },
  {
    "value": "100+",
    "label": "regional banking clients"
  }
]$stats$::jsonb,
  $benefits$[
  {
    "title": "Market Access & Collaboration",
    "bullets": [
      "In-person thematic knowledge sessions with external subject matter experts",
      "In-person thematic round-table discussions with regional bank representatives",
      "Pre-qualified industry introductions for members",
      "Digital community access via WhatsApp"
    ]
  },
  {
    "title": "Market Intelligence",
    "bullets": [
      "Tailored hybrid one-to-one advisory sessions",
      "In-person advisory, training and masterclass sessions",
      "Complimentary access to monthly IBSi FinTech Journal",
      "Exclusive access to IBSi Galaxy Portal",
      "Tailored in-person strategy workshops"
    ]
  },
  {
    "title": "Visibility",
    "bullets": [
      "Special visibility at industry events",
      "Exclusive interviews on IBSi Intelligence website",
      "Leadership coverage on IBS Intelligence podcast",
      "Solution demos and potential Galaxy coverage",
      "Banner feature on IBS Intelligence website",
      "Exclusive access to 30+ annual regional events"
    ]
  },
  {
    "title": "Acceleration",
    "bullets": [
      "Pitch opportunity to Cedar Hill Capital",
      "Co-investment opportunities access",
      "Physical lab infrastructure and meeting rooms",
      "Technology Partner Credits and Global Ecosystem Partner Network access"
    ]
  }
]$benefits$::jsonb
)
ON CONFLICT (id) DO NOTHING;
