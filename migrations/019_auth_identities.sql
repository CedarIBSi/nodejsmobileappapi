-- Stable external identities linked to one internal IBSi account.
-- Human-readable email is profile data and is never the identity key.

CREATE TABLE auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('microsoft')),
  tenant_id text NOT NULL,
  provider_user_id text NOT NULL,
  email_at_link text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, tenant_id, provider_user_id)
);

CREATE INDEX idx_auth_identities_app_user_id ON auth_identities(app_user_id);
