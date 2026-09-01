CREATE TABLE IF NOT EXISTS house_ads (
  id serial PRIMARY KEY,
  title text NOT NULL,
  image_url text NOT NULL,
  link text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
