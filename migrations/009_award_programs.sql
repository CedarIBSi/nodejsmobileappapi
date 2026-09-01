-- Award-programme copy for the app's Awards screen. Not fetched live: see
-- galaxy_page (006_galaxy_page.sql) for why. Content is captured once from a
-- client that isn't blocked and loaded via `npm run seed:awards`.
CREATE TABLE IF NOT EXISTS award_programs (
  slug text PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  link text NOT NULL,
  winners_link text,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
