-- migrate:up
-- Consent is also the issuance authority for implicit first-party consent. It
-- must survive native session/owner erasure while Access floors protect JWTs.
ALTER TABLE auth_consent DROP CONSTRAINT auth_consent_account_id_fkey;
CREATE UNIQUE INDEX auth_consent_client_owner ON auth_consent (client_id, account_id);

-- Quiesce previous issuer binaries before applying this migration.
-- Existing deployments stay closed until an explicit bounded backfill completes.
-- Five minutes drains JWTs whose native owner had already disappeared before
-- deployment. Cookie owners still present are materialized by the backfill.
CREATE TABLE auth_client_coverage (
  client_id text PRIMARY KEY REFERENCES auth_client (client_id),
  after_account text NOT NULL DEFAULT '',
  ready boolean NOT NULL DEFAULT false,
  ready_after timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP + interval '5 minutes'
);
INSERT INTO auth_client_coverage (client_id) SELECT client_id FROM auth_client;

-- The active gate remains the single native client barrier. Progress/receipts
-- survive its removal, binding retries to the same immutable operation.
CREATE TABLE auth_client_reduction_progress (
  operation_id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES auth_client (client_id),
  scopes text[] NOT NULL,
  first_party boolean NOT NULL,
  after_account text NOT NULL DEFAULT '',
  page_after text NOT NULL DEFAULT '',
  terminal_account text,
  completed boolean NOT NULL DEFAULT false
);
INSERT INTO auth_client_reduction_progress (operation_id, client_id, scopes, first_party)
  SELECT operation_id, client_id, scopes, first_party FROM auth_client_reduction;

-- migrate:down
-- Forward only: issuance coverage and completion receipts are security authority.
