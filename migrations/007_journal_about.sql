CREATE TABLE IF NOT EXISTS journal_about (
  edition text PRIMARY KEY CHECK (edition IN ('global', 'india')),
  title text NOT NULL,
  body text NOT NULL,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
