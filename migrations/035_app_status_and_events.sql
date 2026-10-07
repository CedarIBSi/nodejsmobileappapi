-- Two things the app needs from the API that it had no way to ask for.
--
-- 1. app_status: one row that says which build is the oldest the API still
--    supports, and whether there is a service notice to show. Read by every
--    launch through GET /v1/app/status, edited by an admin through PUT
--    /v1/app/status or straight in pgAdmin.
--
-- 2. app_events: the app's own measurement. A short list of named events
--    (app_open, article_open, journal_open, paywall_view, purchase_success,
--    search, notification_open) posted in batches by the app and counted
--    here. No advertising id, no third party, no cross-app identifier: the
--    installation id is the app's own random one, the same one the Insights
--    meter already uses, and the user id is only set for a signed-in reader.
--    This is what lets "how many people read the Journal this week" be
--    answered without an analytics SDK.

CREATE TABLE app_status (
  -- A singleton: the only legal primary key value is true, so a second row
  -- cannot be inserted by accident.
  id boolean PRIMARY KEY DEFAULT true CHECK (id),

  -- Builds older than these are told to update and cannot continue. Compared
  -- as semantic versions ("0.3.0"); the build number is a second, optional
  -- gate for a case where the same version was rebuilt (e.g. the native
  -- notification changes shipped under 0.3.0).
  min_ios_version text NOT NULL DEFAULT '0.0.0',
  min_ios_build integer,
  min_android_version text NOT NULL DEFAULT '0.0.0',
  min_android_build integer,
  update_message text NOT NULL DEFAULT 'This version of the app is no longer supported. Please update to keep reading.',

  -- The service notice. Shown as a banner above the tabs while active and
  -- before notice_until (null = until switched off).
  notice_active boolean NOT NULL DEFAULT false,
  notice_level text NOT NULL DEFAULT 'info' CHECK (notice_level IN ('info', 'warning')),
  notice_title text,
  notice_message text,
  notice_link text,
  notice_until timestamptz,

  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL
);

INSERT INTO app_status (id) VALUES (true);

CREATE TABLE app_events (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  installation_id uuid,
  platform text CHECK (platform IN ('ios', 'android')),
  app_version text,
  build text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX app_events_name_occurred_at ON app_events (name, occurred_at DESC);
CREATE INDEX app_events_occurred_at ON app_events (occurred_at DESC);

-- The question the business asks, pre-answered: events per name per day,
-- with how many distinct installations and signed-in readers produced them.
CREATE VIEW app_events_daily AS
  SELECT
    date_trunc('day', occurred_at)::date AS day,
    name,
    platform,
    count(*) AS events,
    count(DISTINCT installation_id) AS installations,
    count(DISTINCT user_id) AS users
  FROM app_events
  GROUP BY 1, 2, 3;

-- pgAdmin one-liners for the day somebody needs them:
--   Force an update for everything below build 8 on both platforms:
--     UPDATE app_status SET min_ios_build = 8, min_android_build = 8, updated_at = now();
--   Switch on an outage notice:
--     UPDATE app_status SET notice_active = true, notice_level = 'warning',
--       notice_title = 'Planned maintenance',
--       notice_message = 'Some content may be unavailable between 02:00 and 03:00 UTC.',
--       notice_until = now() + interval '3 hours', updated_at = now();
--   Switch it off:
--     UPDATE app_status SET notice_active = false, updated_at = now();
