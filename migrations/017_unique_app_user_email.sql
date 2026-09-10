-- One verified email maps to one application account. Firebase provider
-- linking must happen before /sync-user is called with a different UID.
--
-- Refuse to guess how existing duplicates should be merged: roles,
-- subscriptions and reading data make that a product/security decision.
DO $$
DECLARE duplicate_count integer;
BEGIN
  SELECT count(*) INTO duplicate_count
  FROM (
    SELECT lower(btrim(email))
    FROM app_users
    WHERE email IS NOT NULL AND btrim(email) <> ''
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) duplicates;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'Cannot enforce unique app user emails: % normalized email(s) have duplicate rows',
      duplicate_count;
  END IF;
END $$;

CREATE UNIQUE INDEX app_users_email_unique_ci
  ON app_users (lower(btrim(email)))
  WHERE email IS NOT NULL AND btrim(email) <> '';
