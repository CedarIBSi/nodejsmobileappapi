-- Auditable, duplicate-safe push broadcasts for editor-selected news.
CREATE TABLE article_push_broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  article_id text NOT NULL UNIQUE,
  headline text NOT NULL,
  summary text,
  image_url text,
  requested_by uuid NOT NULL REFERENCES app_users(id),
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'accepted', 'partial', 'failed')),
  target_count integer NOT NULL DEFAULT 0 CHECK (target_count >= 0),
  accepted_count integer NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  delivered_count integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE expo_push_receipts (
  ticket_id text PRIMARY KEY,
  broadcast_id uuid NOT NULL REFERENCES article_push_broadcasts(id) ON DELETE CASCADE,
  push_token_id uuid REFERENCES push_tokens(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'delivered', 'failed')),
  error_code text,
  error_message text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  next_check_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  check_count integer NOT NULL DEFAULT 0 CHECK (check_count >= 0),
  checked_at timestamptz
);

CREATE INDEX expo_push_receipts_pending_idx
  ON expo_push_receipts (next_check_at)
  WHERE status = 'accepted';

