-- Apply ONLY after deploying storeCatalogue aliases and the mobile restore fix,
-- and verifying new store products on test devices. Keep existing plan UUIDs.
DO $$
BEGIN
  IF (SELECT count(*) FROM subscription_plans WHERE code IN (
    'journal_india_monthly', 'journal_india_yearly', 'journal_global_monthly',
    'journal_global_yearly', 'journal_all_monthly', 'journal_all_yearly'
  )) <> 6 THEN
    RAISE EXCEPTION 'Expected the six existing Journal plans; catalogue was not changed';
  END IF;
  IF EXISTS (
    SELECT 1 FROM subscription_plans p
    JOIN (VALUES
      ('journal_india_monthly', 'ibsi_journal_india_monthly', 'test_ibsi_journal_india_monthly'),
      ('journal_india_yearly', 'ibsi_journal_india_yearly', 'test_ibsi_journal_india_yearly'),
      ('journal_global_monthly', 'ibsi_journal_global_monthly', 'test_ibsi_journal_global_monthly'),
      ('journal_global_yearly', 'ibsi_journal_global_yearly', 'test_ibsi_journal_global_yearly'),
      ('journal_all_monthly', 'ibsi_journal_global_india_monthly', 'test_ibsi_journal_all_monthly'),
      ('journal_all_yearly', 'ibsi_journal_global_india_yearly', 'test_ibsi_journal_all_yearly')
    ) AS expected(code, product_id, legacy_id) ON p.code = expected.code
    WHERE p.apple_product_id IS NULL OR p.google_product_id IS NULL
      OR p.apple_product_id NOT IN (expected.product_id, expected.legacy_id)
      OR p.google_product_id NOT IN (expected.product_id, expected.legacy_id)
  ) THEN
    RAISE EXCEPTION 'Unexpected store IDs; catalogue was not changed';
  END IF;
END $$;

UPDATE subscription_plans p
SET apple_product_id = v.product_id, google_product_id = v.product_id,
    name = v.name
FROM (VALUES
  ('journal_india_monthly', 'ibsi_journal_india_monthly', 'IBSi FinTech Journal India Edition - Monthly'),
  ('journal_india_yearly', 'ibsi_journal_india_yearly', 'IBSi FinTech Journal India Edition - Yearly'),
  ('journal_global_monthly', 'ibsi_journal_global_monthly', 'IBSi FinTech Journal Global Edition - Monthly'),
  ('journal_global_yearly', 'ibsi_journal_global_yearly', 'IBSi FinTech Journal Global Edition - Yearly'),
  ('journal_all_monthly', 'ibsi_journal_global_india_monthly', 'IBSi FinTech Journal Global + India Edition - Monthly'),
  ('journal_all_yearly', 'ibsi_journal_global_india_yearly', 'IBSi FinTech Journal Global + India Edition - Yearly')
) AS v(code, product_id, name)
WHERE p.code = v.code;
