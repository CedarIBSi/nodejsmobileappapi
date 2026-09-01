-- Activates the two premium plans with the Google Play test products created
-- in Play Console on 2026-08-31 (test_* IDs on purpose: product IDs can never
-- be deleted or reused, so the throwaway prefix protects the clean names for
-- launch). A follow-up migration swaps in the final ibsi_premium_*_v1 product
-- IDs - and the Apple ones - when those exist; the app picks the change up on
-- its next /plans fetch with no release needed.
--
-- Prices confirmed by the user on 2026-08-31: Rs 99/month, Rs 999/year
-- (yearly was Rs 400 in 002). Store checkout charges Play Console's own
-- price; these amounts are what the app displays before store data loads.

UPDATE subscription_plans SET
  google_product_id = 'test_premium_monthly_01',
  price_amount = 9900,
  status = 'active',
  updated_at = now()
WHERE code = 'premium_monthly';

UPDATE subscription_plans SET
  google_product_id = 'test_premium_yearly_01',
  price_amount = 99900,
  status = 'active',
  updated_at = now()
WHERE code = 'premium_yearly';
