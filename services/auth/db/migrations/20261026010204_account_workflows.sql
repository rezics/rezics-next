-- migrate:up
-- This is Auth-only encrypted input staging, not workflow execution state.
-- DBOS owns its own schema and history in the separately configured system DB.
CREATE TABLE auth_registration_stage (
  registration_id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  handle text NOT NULL,
  account_id text NOT NULL UNIQUE,
  reservation_id text,
  request_digest bytea NOT NULL,
  ciphertext bytea,
  credential_digest bytea,
  expires_at timestamptz,
  completed_at timestamptz,
  expired_at timestamptz
);
CREATE INDEX auth_registration_stage_due ON auth_registration_stage (expires_at, registration_id)
  WHERE completed_at IS NULL AND expired_at IS NULL;

-- A lower UTC evidence migration may already establish this receipt table.
CREATE TABLE IF NOT EXISTS auth_provisioning_receipt (
  idempotency_key text PRIMARY KEY,
  account_id text NOT NULL UNIQUE,
  digest bytea NOT NULL
);

CREATE TABLE auth_workflow_request (
  workflow_id text PRIMARY KEY,
  digest bytea NOT NULL,
  request jsonb NOT NULL
);

-- migrate:down
-- Forward only: credential installation and request bindings survive recovery.
