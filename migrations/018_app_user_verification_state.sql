-- Make app_users a true mirror of Firebase, rather than a list of the verified.
--
-- sync-user refused to create a row for an unverified address, which meant an
-- account could exist in Firebase and nowhere here. Everything that reasons
-- about accounts was wrong for those people: the profile lookup 404ed, the
-- delete route refused them outright until it was fixed, they could hold no
-- entitlement, and any question of the form "does this email have an account"
-- answered no while the reader was looking at the account they had just made.
--
-- The row now exists from the first sign-in and carries the two facts that were
-- being inferred badly elsewhere.
--
-- email_verified is the state at the last sync, not a live read. Firebase
-- remains the authority; this is a cache, refreshed every time the client syncs
-- with a fresh token. Treat a true here as "verified as of their last visit"
-- and never as a substitute for the token claim on a request that matters.
--
-- sign_in_provider records how they last got in - 'password', 'google.com'.
-- Not the full list of linked providers, which only firebase-admin can give;
-- with one account per email address it is a sound proxy, because someone who
-- signed up with Google has no password to sign in with and so never overwrites
-- it. Nullable because rows predating this migration have no answer, and
-- guessing one would be worse than admitting it.

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sign_in_provider text;

-- Every row that exists today was created by the old sync-user, which only ever
-- admitted verified addresses. Backfilling false would tell the app that every
-- established account suddenly needs verifying.
UPDATE app_users SET email_verified = true WHERE email IS NOT NULL;

-- The lookup behind the sign-in screen reads by normalised email and nothing
-- else. 017 already indexes that expression uniquely, so this adds no index -
-- it is noted here so the next person does not add a redundant one.
