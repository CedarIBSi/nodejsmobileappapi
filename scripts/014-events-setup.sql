-- Standalone setup for GET /v1/events, for running by hand in psql as a user
-- that can create tables (e.g. postgres). Equivalent to:
--   npm run migrate   (migration 014_events.sql)
--   npm run seed:events
--
-- Needed because `npm run migrate` currently stops before 014: migrations 012
-- and 013 ALTER the subscriptions table, which the app user ibs_news_api does
-- not own, so the runner aborts on "must be owner of table subscriptions" and
-- never reaches this one. Nothing below touches subscriptions.
--
-- Safe to re-run: the tables are created IF NOT EXISTS and every row is an
-- upsert. Re-running resets the seeded content to what is written here.

BEGIN;

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

-- The app connects as ibs_news_api. Tables created by another role are
-- unreadable to it, which would leave GET /v1/events failing with "permission
-- denied for table events" rather than anything obviously schema-related.
ALTER TABLE events OWNER TO ibs_news_api;
ALTER TABLE events_page OWNER TO ibs_news_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON events, events_page TO ibs_news_api;

-- ---------------------------------------------------------------------------
-- Content, matching seed-data/events.json
-- ---------------------------------------------------------------------------

INSERT INTO events_page (id, intro, about, stats, series, videos, insights, updated_at)
VALUES (
  1,
  'The Cedar-IBSi summit series and the boardroom conversations around it - who is convening, where, and when.',
  '{"heading": "About Cedar-IBSi", "body": ["Cedar Management Consulting International and IBS Intelligence run a shared events platform dedicated to the future of banking technology. Both firms curate a global Events & Awards calendar built for senior banking leadership, with FinTech innovators joining as event partners."], "points": ["Thought-leadership summits across the UK, Middle East, and Asia", "The flagship IBSi Awards programmes", "Curated boardroom discussions and networking, by invitation"]}'::jsonb,
  '[{"label": "In-person attendees", "value": "3,000+"}, {"label": "Banks & institutions engaged", "value": "500+"}, {"label": "Senior speakers in the series", "value": "400+"}, {"label": "Start-up founders engaged", "value": "100+"}, {"label": "Summits across 2026", "value": "8"}, {"label": "Host cities worldwide", "value": "7"}, {"label": "Industry awards programmes", "value": "4"}]'::jsonb,
  '[{"key": "summits", "title": "Summits", "body": "Global thought-leadership summits convening banks, FinTechs, and consulting leaders across the UK, the Middle East, and Asia.", "items": []}, {"key": "awards", "title": "Awards", "body": "", "items": ["IBSi Digital Banking Awards", "IBSi Middle East Banking Excellence Awards", "IBSi Sales League Table", "IBSi Global FinTech Innovation Awards"]}, {"key": "boardroom-conversations", "title": "Boardroom Conversations", "body": "Curated boardroom discussions and social gatherings - FinTech X AI Ideas on Ice, InsurTech Stack and more.", "items": []}, {"key": "founder-happy-hour", "title": "Founder Happy Hour", "body": "Informal evening gatherings connecting founders and investors across the FinTech Lab and Cedar Hill Capital community.", "items": []}]'::jsonb,
  '[{"id": "summits-2025-highlights", "title": "Cedar-IBSi Summits - 2025 highlights", "youtubeId": "G2Hm_84jU7I", "thumbnailUrl": null, "dateLabel": "2025"}, {"id": "summits-2024-highlights", "title": "Cedar-IBSi Summits - 2024 highlights", "youtubeId": "B-o52DpdTsU", "thumbnailUrl": null, "dateLabel": "2024"}, {"id": "summits-2023-highlights", "title": "Cedar-IBSi Summits - 2023 highlights", "youtubeId": "QH2ZFBDQTUE", "thumbnailUrl": null, "dateLabel": "2023"}]'::jsonb,
  '[{"id": "digital-islamic-banking", "title": "Adding the Power of Digital to Islamic Banking", "topic": "Digital Banking", "summary": ""}, {"id": "modernizing-payments-oman", "title": "Modernizing Payments in Oman - The Way Forward", "topic": "Payments", "summary": ""}, {"id": "nextgen-banking-gcc", "title": "NextGen Banking: Transforming Customer Engagement in the GCC", "topic": "GCC", "summary": ""}]'::jsonb,
  now()
)
ON CONFLICT (id) DO UPDATE
SET intro = EXCLUDED.intro, about = EXCLUDED.about, stats = EXCLUDED.stats,
    series = EXCLUDED.series, videos = EXCLUDED.videos,
    insights = EXCLUDED.insights, updated_at = now();

INSERT INTO events (id, title, summary, date_label, starts_on, city, venue,
                    image_url, is_featured, registration_email, is_published,
                    sort_order)
VALUES
  ('2026-dubai-building-a-future-ready-bank', 'Building a Future-Ready Bank', 'The Cedar-IBSi Dubai Summit, where banking leaders convene to build the future-ready bank.', '30 September 2026', '2026-09-30'::date, 'Dubai, UAE', NULL, 'https://cedaribsi.events/images/banner/2026-Sep-Dubai-Event.webp', true, NULL, true, 0),
  ('2026-muscat-building-a-future-ready-bank', 'Building a Future-Ready Bank', 'The Cedar-IBSi Muscat Summit, where banking leaders convene to build the future-ready bank.', '28 October 2026', '2026-10-28'::date, 'Muscat, Oman', NULL, 'https://cedaribsi.events/images/gallery/2026-11-IBSi-Muscat/2026IBSi11Muscat.png', false, NULL, true, 1),
  ('2026-mumbai-building-a-future-ready-bank', 'Building a Future-Ready Bank', 'The Cedar-IBSi Mumbai Summit, where banking leaders convene to build the future-ready bank.', '27 November 2026', '2026-11-27'::date, 'Mumbai, India', NULL, 'https://cedaribsi.events/images/gallery/2026-12-IBSi-Mumbai/2026IBSi12Mumbai.png', false, NULL, true, 2),
  ('2026-mumbai-ibsi-global-fintech-innovation-awards', 'IBSi Global FinTech Innovation Awards', 'The annual IBSi Global FinTech Innovation Awards, held alongside the Mumbai summit.', '27 November 2026', '2026-11-27'::date, 'Mumbai, India', NULL, 'https://cedaribsi.events/images/banner/GFIA7-scaled.jpg', false, NULL, true, 3)
ON CONFLICT (id) DO UPDATE
SET title = EXCLUDED.title, summary = EXCLUDED.summary,
    date_label = EXCLUDED.date_label, starts_on = EXCLUDED.starts_on,
    city = EXCLUDED.city, venue = EXCLUDED.venue,
    image_url = EXCLUDED.image_url, is_featured = EXCLUDED.is_featured,
    registration_email = EXCLUDED.registration_email,
    is_published = EXCLUDED.is_published, sort_order = EXCLUDED.sort_order,
    updated_at = now();

-- Records 014 as applied so `npm run migrate` does not run it again once the
-- subscriptions ownership problem blocking 012/013 is sorted out.
INSERT INTO schema_migrations (filename)
VALUES ('014_events.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;

-- Check it took:
--   SELECT id, date_label, is_featured FROM events ORDER BY sort_order;
--   SELECT jsonb_array_length(stats) AS stats, jsonb_array_length(series) AS series,
--          jsonb_array_length(videos) AS videos FROM events_page WHERE id = 1;
