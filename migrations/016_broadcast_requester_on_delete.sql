-- Let a broadcast outlive the admin who requested it.
--
-- 015 created article_push_broadcasts.requested_by as NOT NULL REFERENCES
-- app_users(id) with no ON DELETE clause, which Postgres reads as NO ACTION.
-- Every other foreign key onto app_users names its behaviour; this one was the
-- exception, and the effect was that DELETE /v1/auth/me raised a foreign key
-- violation for any admin who had ever sent a broadcast. They could not delete
-- their account at all, and until the route's delete order was corrected that
-- failure also destroyed their Firebase login on the way past.
--
-- SET NULL rather than CASCADE: the broadcast row is an audit record of a push
-- that really was sent to readers, so it has to survive. Only the link to the
-- person is dropped, which is also what account deletion is supposed to do.
--
-- Ordering note: this runs after 015 in every case - the runner applies files
-- in filename order - so it corrects an existing database and, on a fresh one,
-- immediately corrects the constraint 015 just created.

ALTER TABLE article_push_broadcasts
  ALTER COLUMN requested_by DROP NOT NULL;

ALTER TABLE article_push_broadcasts
  DROP CONSTRAINT IF EXISTS article_push_broadcasts_requested_by_fkey;

ALTER TABLE article_push_broadcasts
  ADD CONSTRAINT article_push_broadcasts_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES app_users(id) ON DELETE SET NULL;
