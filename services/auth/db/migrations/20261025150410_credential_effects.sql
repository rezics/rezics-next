-- migrate:up
-- Stage and terminal result share the existing Auth effect ledger. Legacy rows
-- have no stage locator and can never be interpreted as a committed success.
ALTER TABLE auth_effect_receipt
  ADD COLUMN operation_key text,
  ADD COLUMN effect_reference text,
  ADD COLUMN effect_digest text,
  ADD COLUMN stage_version integer,
  ADD COLUMN credential_row_id text,
  ADD COLUMN credential_row_version text,
  ADD COLUMN acting_human_id text,
  ADD COLUMN client_id text,
  ADD COLUMN scopes text[],
  ADD COLUMN stage_ciphertext bytea,
  ADD COLUMN opening_receipt_id text,
  ADD COLUMN committed_result jsonb,
  ADD COLUMN committed_at timestamptz;
CREATE UNIQUE INDEX auth_credential_operation ON auth_effect_receipt(account_id,operation_key)
  WHERE operation_key IS NOT NULL;
CREATE UNIQUE INDEX auth_credential_reference ON auth_effect_receipt(effect_reference)
  WHERE effect_reference IS NOT NULL;
ALTER TABLE auth_effect_receipt ADD CONSTRAINT auth_credential_stage CHECK ((
  (operation_key IS NULL AND effect_reference IS NULL AND effect_digest IS NULL AND stage_version IS NULL
   AND stage_ciphertext IS NULL AND committed_result IS NULL AND committed_at IS NULL AND opening_receipt_id IS NULL)
  OR
  (operation_key IS NOT NULL AND effect_reference IS NOT NULL AND effect_digest ~ '^[a-f0-9]{64}$'
   AND stage_version=1 AND stage_ciphertext IS NOT NULL AND acting_human_id IS NOT NULL
   AND client_id IS NOT NULL AND scopes IS NOT NULL
   AND purpose IN ('set-password','remove-password','add-key','remove-key')
   AND ((credential_row_id IS NULL) = (credential_row_version IS NULL))
   AND ((committed_at IS NULL AND committed_result IS NULL AND opening_receipt_id IS NULL)
     OR (committed_at IS NOT NULL AND opening_receipt_id IS NOT NULL
       AND committed_result = jsonb_build_object('receiptId',receipt_id,'replayed',false))))
) IS TRUE);
CREATE FUNCTION auth_credential_stage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.operation_key IS NULL AND NEW.operation_key IS NOT NULL) OR
    (OLD.operation_key IS NOT NULL AND (
    (to_jsonb(NEW) - ARRAY['opening_receipt_id','committed_result','committed_at','minimum_authn_epoch'])
      IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['opening_receipt_id','committed_result','committed_at','minimum_authn_epoch'])
    OR OLD.committed_at IS NOT NULL
  )) THEN
    RAISE EXCEPTION 'Credential stage is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_credential_stage_immutable BEFORE UPDATE ON auth_effect_receipt
  FOR EACH ROW EXECUTE FUNCTION auth_credential_stage_immutable();

-- migrate:down
-- Forward-only: immutable credential operations and receipts must survive retry.
