-- migrate:up
-- A credential owner need not have an email or an independent password.
ALTER TABLE "user" ALTER COLUMN email DROP NOT NULL;
ALTER TABLE account DROP CONSTRAINT password_owner;
ALTER TABLE account ADD CONSTRAINT password_owner CHECK (
  "providerId" = 'credential' AND "accountId" = "userId"
);
ALTER TABLE session DROP CONSTRAINT session_authentication;
ALTER TABLE session ADD CONSTRAINT session_authentication CHECK (
  "authnEpoch" >= 0 AND "authTime" >= 0 AND "authMethods" IN ('pwd', 'private_key_jwt', 'operator')
);
CREATE TABLE auth_public_key (
  account_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  kid text NOT NULL,
  public_jwk jsonb NOT NULL CHECK (public_jwk->>'alg' = 'ES256' AND NOT public_jwk ? 'd' AND NOT public_jwk ? 'k'),
  PRIMARY KEY (account_id, kid)
);
CREATE TABLE auth_key_assertion (
  account_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  jti text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, jti)
);
CREATE TABLE auth_effect_receipt (
  receipt_id text PRIMARY KEY,
  account_id text NOT NULL,
  purpose text NOT NULL,
  minimum_authn_epoch integer NOT NULL CHECK (minimum_authn_epoch >= 0)
);
CREATE TABLE auth_session_opening (
  session_id text PRIMARY KEY,
  subject_account_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  acting_human_id text NOT NULL,
  operator_account_id text NOT NULL,
  receipt_id text NOT NULL UNIQUE,
  opened_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE auth_recovery (
  proof_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  authn_epoch integer NOT NULL CHECK (authn_epoch >= 0),
  expires_at timestamptz NOT NULL
);

-- migrate:down
-- Forward-only: credential and recovery barriers must not be rolled back.
