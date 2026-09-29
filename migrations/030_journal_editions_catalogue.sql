-- Three products, each monthly and yearly, replacing the one binary premium
-- plan. Decided by the user on 2026-09-29: the IBSi FinTech Journal India
-- edition, the Global edition, and India + Global, every one of them also
-- including unlimited Insights. See src/lib/catalogue.ts for what each
-- product grants.
--
-- The six store product ids below are chosen here and must be created with
-- exactly these ids in Play Console (one subscription product each, one base
-- plan each) and App Store Connect (all six in ONE subscription group, ranked
-- India + Global above Global above India). Until a product exists in a store
-- the app shows its price slot as pending and cannot sell it; nothing breaks.
--
-- test_ prefix on purpose, as with the first two products: store product ids
-- can never be deleted or reused, so these throwaways protect the clean
-- ibsi_journal_* names for launch. A follow-up migration swaps the ids once
-- the real products are approved; the app picks that up on its next /plans
-- fetch with no release.
--
-- The two old plans are retired, not deleted: existing subscriptions point at
-- them, and their renewals keep reconciling. Their product_code is
-- journal_all because that is what they granted.
BEGIN;

ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS product_code text;

UPDATE subscription_plans SET product_code = 'journal_all', status = 'retired', updated_at = now()
 WHERE code IN ('premium_monthly', 'premium_yearly');

-- price_amount is a reference figure only; the stores quote the real price.
-- Monthly INR set by the user on 2026-09-29: India 90, Global 599, both 649.
-- Annual is ten times monthly on every product (two months free, a 17%
-- saving): India 900, Global 5990, both 6490. Chosen over holding India at
-- the website's Rs 990 so the saving reads the same on all three.
INSERT INTO subscription_plans
  (code, name, product_code, price_amount, currency, "interval", status, apple_product_id, google_product_id)
VALUES
  ('journal_india_monthly',  'IBSi Journal India - Monthly',           'journal_india',  9000,   'INR', 'monthly', 'active', 'test_ibsi_journal_india_monthly',  'test_ibsi_journal_india_monthly'),
  ('journal_india_yearly',   'IBSi Journal India - Annual',            'journal_india',  90000,  'INR', 'yearly',  'active', 'test_ibsi_journal_india_yearly',   'test_ibsi_journal_india_yearly'),
  ('journal_global_monthly', 'IBSi Journal Global - Monthly',          'journal_global', 59900,  'INR', 'monthly', 'active', 'test_ibsi_journal_global_monthly', 'test_ibsi_journal_global_monthly'),
  ('journal_global_yearly',  'IBSi Journal Global - Annual',           'journal_global', 599000, 'INR', 'yearly',  'active', 'test_ibsi_journal_global_yearly',  'test_ibsi_journal_global_yearly'),
  ('journal_all_monthly',    'IBSi Journal India + Global - Monthly',  'journal_all',    64900,  'INR', 'monthly', 'active', 'test_ibsi_journal_all_monthly',    'test_ibsi_journal_all_monthly'),
  ('journal_all_yearly',     'IBSi Journal India + Global - Annual',   'journal_all',    649000, 'INR', 'yearly',  'active', 'test_ibsi_journal_all_yearly',     'test_ibsi_journal_all_yearly')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE subscription_plans
  ALTER COLUMN product_code SET NOT NULL,
  ADD CONSTRAINT subscription_plans_product_code_check
    CHECK (product_code IN ('journal_india', 'journal_global', 'journal_all'));

-- The single 'premium_news' entitlement stood for everything. Split each one
-- into the three rows the catalogue now writes, keeping its status and dates,
-- so nobody who holds access today loses any of it.
INSERT INTO entitlements
  (user_id, subscription_id, entitlement_type, status, starts_at, ends_at, source, created_at, updated_at)
SELECT e.user_id, e.subscription_id, t.entitlement_type, e.status, e.starts_at, e.ends_at, e.source,
       e.created_at, now()
  FROM entitlements e
  CROSS JOIN (VALUES ('insights'), ('journal_india'), ('journal_global')) AS t(entitlement_type)
 WHERE e.entitlement_type = 'premium_news'
ON CONFLICT (subscription_id, entitlement_type) DO NOTHING;

DELETE FROM entitlements WHERE entitlement_type = 'premium_news';

ALTER TABLE entitlements
  ADD CONSTRAINT entitlements_type_check
    CHECK (entitlement_type IN ('insights', 'journal_india', 'journal_global'));

COMMIT;
