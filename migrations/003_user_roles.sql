-- Staff roles grant unlimited content access without a paid subscription.
-- Roles are assigned manually via SQL; there is no self-service path and no
-- automatic grant from email domain, so a new account is always 'user'.
ALTER TABLE app_users
  ADD COLUMN role text NOT NULL DEFAULT 'user'
    CHECK (role IN ('user', 'employee', 'admin', 'super_admin'));

-- Staff lookups happen on every metered article read and media listing.
CREATE INDEX idx_app_users_role ON app_users(role) WHERE role <> 'user';
