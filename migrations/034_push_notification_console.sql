-- General push broadcasts for the editorial notification console. Existing
-- article broadcasts and Expo receipt rows remain intact; PostgreSQL follows
-- the table rename through the receipt foreign key.
ALTER TABLE article_push_broadcasts RENAME TO push_broadcasts;

ALTER TABLE push_broadcasts
  ADD COLUMN kind text NOT NULL DEFAULT 'article'
    CHECK (kind IN ('article', 'message')),
  ADD COLUMN title text,
  ADD COLUMN body text,
  ADD COLUMN data jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN audience jsonb NOT NULL DEFAULT '{"type":"all"}'::jsonb,
  ADD COLUMN scheduled_at timestamptz,
  ADD COLUMN cancelled_at timestamptz,
  ALTER COLUMN article_id DROP NOT NULL,
  ALTER COLUMN headline DROP NOT NULL,
  DROP CONSTRAINT article_push_broadcasts_article_id_key;

CREATE UNIQUE INDEX push_broadcasts_article_once
  ON push_broadcasts (article_id)
  WHERE article_id IS NOT NULL;

ALTER TABLE push_broadcasts
  DROP CONSTRAINT article_push_broadcasts_status_check;

ALTER TABLE push_broadcasts
  ADD CONSTRAINT push_broadcasts_status_check CHECK (
    status IN ('scheduled', 'processing', 'accepted', 'partial', 'failed', 'cancelled')
  );

CREATE INDEX push_broadcasts_schedule_idx
  ON push_broadcasts (scheduled_at)
  WHERE status = 'scheduled';

