-- 037 may already have run with article_id as NULL. This migration updates the
-- existing curated Perspective row so the app opens the IBSi article natively
-- instead of falling back to the external website link.
UPDATE home_perspective
SET
  article_id = 'slug:banks-recalibrate-as-resilience-becomes-the-new-technology-mandate-2',
  updated_at = now()
WHERE id = 1
  AND link = 'https://ibsintelligence.com/banks-recalibrate-as-resilience-becomes-the-new-technology-mandate-2/'
  AND (article_id IS NULL OR article_id = '');
