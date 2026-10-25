-- migrate:up
-- Receipts preserve exact native evidence, never credentials or bearer tokens.
ALTER TABLE auth_consent ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE FUNCTION auth_consent_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision + CASE WHEN NEW.scopes IS DISTINCT FROM OLD.scopes THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_consent_revision BEFORE UPDATE ON auth_consent
  FOR EACH ROW EXECUTE FUNCTION auth_consent_revision();

ALTER TABLE auth_recovery ADD COLUMN consumed_operation text,
  ADD COLUMN consumed_verification_id text,
  ADD COLUMN consumed_at timestamptz,
  ADD CONSTRAINT auth_recovery_consumption CHECK (
    (consumed_operation IS NULL AND consumed_verification_id IS NULL AND consumed_at IS NULL) OR
    (consumed_operation IS NOT NULL AND consumed_verification_id IS NOT NULL AND consumed_at IS NOT NULL)
  );

CREATE TABLE auth_barrier_proof (
  reference text PRIMARY KEY CHECK (reference ~ '^[0-9a-f]{64}$'),
  account_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE CHECK (length(account_id) BETWEEN 1 AND 1024),
  purpose text NOT NULL CHECK (purpose IN ('consent-reduction','recovery')),
  previous_epoch integer NOT NULL CHECK (previous_epoch >= 0),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 128),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND octet_length(evidence::text) <= 65536),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  applied_at timestamptz,
  UNIQUE (account_id,purpose,operation_key),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes')
);
CREATE INDEX auth_barrier_proof_expiry ON auth_barrier_proof (expires_at,reference);
CREATE FUNCTION auth_barrier_proof_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'applied_at') IS DISTINCT FROM (to_jsonb(OLD) - 'applied_at')
    OR OLD.applied_at IS NOT NULL OR NEW.applied_at IS NULL THEN
    RAISE EXCEPTION 'Barrier evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_barrier_proof_immutable BEFORE UPDATE ON auth_barrier_proof
  FOR EACH ROW EXECUTE FUNCTION auth_barrier_proof_immutable();

-- migrate:down
-- Forward only: deleting consumption evidence must never make a proof reusable.
