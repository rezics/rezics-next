-- migrate:up
-- The existing workflow migration is future-stamped. Establish only its same
-- receipt table on fresh databases; upgrades retain existing native receipts.
CREATE TABLE IF NOT EXISTS auth_provisioning_receipt (
  idempotency_key text PRIMARY KEY,
  account_id text NOT NULL UNIQUE,
  digest bytea NOT NULL
);
-- Existing receipts remain idempotency records only. Never infer evidence for
-- historical rows from staging or owner existence.
ALTER TABLE auth_provisioning_receipt
  ADD COLUMN registration_id text,
  ADD COLUMN reservation_id text,
  ADD COLUMN authn_epoch bigint,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN owner_id text REFERENCES "user"(id) ON DELETE CASCADE,
  ADD COLUMN credential_id text REFERENCES account(id) ON DELETE CASCADE,
  ADD COLUMN provisioning_kind text,
  ADD CONSTRAINT auth_provisioning_evidence_complete CHECK (
    (registration_id IS NULL AND reservation_id IS NULL AND authn_epoch IS NULL
      AND expires_at IS NULL AND owner_id IS NULL AND credential_id IS NULL AND provisioning_kind IS NULL)
    OR
    (registration_id IS NOT NULL AND reservation_id IS NOT NULL AND authn_epoch IS NOT NULL
      AND authn_epoch BETWEEN 1 AND 9007199254740991 AND expires_at IS NOT NULL
      AND owner_id IS NOT NULL AND owner_id=account_id AND credential_id IS NOT NULL
      AND provisioning_kind IS NOT NULL AND provisioning_kind IN ('password','credentialless'))
  );
CREATE INDEX auth_provisioning_receipt_owner_idx ON auth_provisioning_receipt(owner_id);
CREATE INDEX auth_provisioning_receipt_credential_idx ON auth_provisioning_receipt(credential_id);

CREATE FUNCTION auth_provisioning_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provisioning receipts are immutable';
END;
$$;
CREATE TRIGGER auth_provisioning_receipt_immutable BEFORE UPDATE ON auth_provisioning_receipt
  FOR EACH ROW EXECUTE FUNCTION auth_provisioning_receipt_immutable();

-- migrate:down
-- Forward only: original pending bindings must survive native retries.
