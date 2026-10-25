-- migrate:up
-- Only the credential mutation transaction writes a witness. The original
-- bounded proof lifetime/erasure cleanup owns its at-most-one dependent row.
CREATE TABLE auth_recovery_establishment (
  reference text PRIMARY KEY REFERENCES auth_barrier_proof(reference) ON DELETE CASCADE,
  receipt_id text NOT NULL UNIQUE REFERENCES auth_effect_receipt(receipt_id),
  account_id text NOT NULL,
  credential_id text NOT NULL,
  credential_fingerprint text NOT NULL CHECK (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  effect_commitment text NOT NULL CHECK (effect_commitment ~ '^[0-9a-f]{64}$'),
  establishment_id text NOT NULL UNIQUE,
  authn_epoch integer NOT NULL CHECK (authn_epoch > 0)
);

-- migrate:down
-- Forward only: removing successful credential evidence must never enable replay.
