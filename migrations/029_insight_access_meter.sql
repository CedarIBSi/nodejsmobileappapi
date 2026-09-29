-- Moves the free-read meter from News to Insights.
--
-- News is free from here on: the app no longer calls POST /v1/news/access and
-- GET /v1/news/articles/:id serves every body to every caller. What is metered
-- instead is everything on the app's Insights tab - analyst opinions,
-- leadership interviews, white papers, podcasts and videos - on one shared
-- allowance of five reads per calendar month (Asia/Kolkata), counted per
-- signed-in user or, before sign-in, per installation. Same rules as the news
-- meter had: reopening something already read is free, sign-in merges the
-- installation's reads into the account, premium and staff bypass it.
--
-- A new table rather than a rename of news_article_access. Its rows are news
-- reads, and carrying them over would spend a reader's Insights allowance on
-- articles that are now free. It is left in place, unread, so the application
-- code can be rolled back without a second migration; drop it once this has
-- bedded in.
CREATE TABLE insight_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  installation_id uuid,
  -- Constrained here as well as in code: a typo in a route would otherwise
  -- create a sixth bucket that nothing reads and nothing counts.
  content_type text NOT NULL CHECK (
    content_type IN ('analyst_opinion', 'leadership_interview', 'whitepaper', 'podcast', 'video')
  ),
  content_id text NOT NULL,
  period_start date NOT NULL,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((user_id IS NOT NULL)::integer + (installation_id IS NOT NULL)::integer = 1)
);

CREATE UNIQUE INDEX idx_insight_access_user_content_period
  ON insight_access(user_id, content_type, content_id, period_start)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_insight_access_install_content_period
  ON insight_access(installation_id, content_type, content_id, period_start)
  WHERE installation_id IS NOT NULL;
CREATE INDEX idx_insight_access_user_period
  ON insight_access(user_id, period_start);
CREATE INDEX idx_insight_access_install_period
  ON insight_access(installation_id, period_start);
