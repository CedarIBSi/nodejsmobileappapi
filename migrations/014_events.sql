-- The Cedar-IBSi events programme, shown on the app's Events screen.
--
-- Unlike galaxy_page (006) and award_programs (009), nothing here is scraped.
-- The source is cedaribsi.events, a hand-authored static site with no CMS and
-- no REST API to read - so the content is curated in seed-data/events.json and
-- loaded with `npm run seed:events`.
--
-- Split in two on purpose. The upcoming list is the part that moves - an event
-- is added, one passes, one is promoted into the featured slot - so it gets
-- rows of its own with ordering and a publish flag. The rest of the page is a
-- document that changes as a whole, and is held as a single row.
CREATE TABLE IF NOT EXISTS events_page (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  intro text NOT NULL DEFAULT '',
  about jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '[]'::jsonb,
  series jsonb NOT NULL DEFAULT '[]'::jsonb,
  videos jsonb NOT NULL DEFAULT '[]'::jsonb,
  insights jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  -- Written out by hand ("30 September 2026") and shown by the app as-is, so
  -- one summit's date cannot render differently on two devices.
  date_label text NOT NULL DEFAULT '',
  -- Orders the list, and drops the event from it the day after it runs. Null
  -- for an event whose date is not yet fixed - that one always shows, and is
  -- withdrawn by clearing is_published instead.
  starts_on date,
  city text NOT NULL DEFAULT '',
  venue text,
  -- Absolute URL. Event banners are served from cedaribsi.events; the app
  -- fetches them at render time and bundles nothing.
  image_url text,
  is_featured boolean NOT NULL DEFAULT false,
  -- Overrides the app's default events address for an event run by another
  -- team. Registration is an email, not a booking link - the app deliberately
  -- never sends a reader to cedaribsi.events.
  registration_email text,
  is_published boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_published_idx ON events (is_published, starts_on);
