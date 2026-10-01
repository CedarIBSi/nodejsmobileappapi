-- "Express interest" from the app's From IBSi pages. Every tap is recorded
-- here and emailed to the sales inbox (INTEREST_TO_EMAIL); the row is the
-- record of what was sent, and the safety net when mail is not configured or
-- fails - emailed_at stays NULL and the lead is not lost.
CREATE TABLE interest_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE SET NULL,
  -- The page the reader was on: "IBSi Galaxy", "Advisory Services", ...
  topic text NOT NULL,
  -- Copied from the account at the time, so the lead reads the same after
  -- the reader renames themselves or deletes the account.
  name text,
  email text,
  platform text,
  emailed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_interest_requests_created_at ON interest_requests(created_at DESC);
