-- migrate:up
-- Auth credential owners are Access IDs, never independent public identities.
ALTER TABLE "user" ADD CONSTRAINT inert_profile CHECK (name = '' AND image IS NULL);
ALTER TABLE account ADD CONSTRAINT password_owner CHECK (
  "providerId" = 'credential' AND "accountId" = "userId" AND password IS NOT NULL
);
ALTER TABLE account ADD CONSTRAINT credential_owner_unique UNIQUE ("userId", "providerId");

CREATE TABLE auth_client (
  client_id text PRIMARY KEY,
  first_party boolean NOT NULL,
  scopes text[] NOT NULL
);
CREATE TABLE auth_consent (
  account_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES auth_client (client_id) ON DELETE CASCADE,
  scopes text[] NOT NULL,
  PRIMARY KEY (account_id, client_id)
);
ALTER TABLE session ADD CONSTRAINT session_client_fk FOREIGN KEY ("clientId") REFERENCES auth_client (client_id);
ALTER TABLE session ADD CONSTRAINT session_authentication CHECK (
  "authnEpoch" >= 0 AND "authTime" >= 0 AND "authMethods" = 'pwd'
);
CREATE TABLE auth_signing_key (
  kid text PRIMARY KEY,
  private_jwk jsonb NOT NULL CHECK (private_jwk->>'d' IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- migrate:down
DROP TABLE auth_signing_key;
ALTER TABLE session DROP CONSTRAINT session_authentication;
ALTER TABLE session DROP CONSTRAINT session_client_fk;
DROP TABLE auth_consent, auth_client;
ALTER TABLE account DROP CONSTRAINT credential_owner_unique;
ALTER TABLE account DROP CONSTRAINT password_owner;
ALTER TABLE "user" DROP CONSTRAINT inert_profile;
