-- The in-app notification bell. The inbox itself is push_broadcasts, read
-- per reader; this table only remembers how far each signed-in reader has
-- read, so the bell's unread dot follows them between devices. Signed-out
-- readers keep the same timestamp on the device instead.
CREATE TABLE notification_inbox_seen (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The inbox reads the last 30 days, newest first.
CREATE INDEX push_broadcasts_inbox_idx
  ON push_broadcasts ((COALESCE(scheduled_at, created_at)) DESC);
