-- The curated IBSi Perspective block on the home feed.
--
-- This is one editable row, not a feed. The team can change the image, title
-- and link whenever the featured perspective changes, and the app will pick it
-- up from /v1/home/perspective without a new mobile release.
CREATE TABLE IF NOT EXISTS home_perspective (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Optional WordPress post id. When present, the app can open the article
  -- inside the native article detail screen; otherwise it falls back to link.
  article_id text,
  title text NOT NULL,
  image_url text NOT NULL,
  link text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  ends_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO home_perspective (id, article_id, title, image_url, link, is_active)
VALUES (
  1,
  NULL,
  'Banks recalibrate as resilience becomes the new technology mandate',
  'https://ibsintelligence.com/wp-content/uploads/2026/03/IBSi-West-Asia-Crisis-1x1-MPU-1-1536x1536.png',
  'https://ibsintelligence.com/banks-recalibrate-as-resilience-becomes-the-new-technology-mandate-2/',
  true
)
ON CONFLICT (id) DO NOTHING;
