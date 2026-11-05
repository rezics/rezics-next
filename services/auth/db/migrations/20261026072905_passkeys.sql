-- migrate:up
ALTER TABLE session DROP CONSTRAINT session_authentication;
ALTER TABLE session ADD CONSTRAINT session_authentication CHECK (
  "authnEpoch" >= 0 AND "authTime" >= 0 AND "authMethods" IN ('pwd','pop','private_key_jwt','operator')
);
CREATE TABLE passkey (
  id text PRIMARY KEY,
  name text,
  "publicKey" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "credentialID" text NOT NULL,
  counter bigint NOT NULL,
  "deviceType" text NOT NULL,
  "backedUp" boolean NOT NULL,
  transports text,
  "createdAt" timestamptz NOT NULL,
  aaguid text,
  last_used_at timestamptz
);
CREATE UNIQUE INDEX passkey_credentialID_idx ON passkey ("credentialID");
CREATE INDEX passkey_userId_idx ON passkey ("userId",id);
CREATE FUNCTION auth_passkey_used() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.last_used_at := statement_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER auth_passkey_used BEFORE UPDATE OF counter ON passkey
  FOR EACH ROW EXECUTE FUNCTION auth_passkey_used();
ALTER TABLE auth_effect_receipt ADD COLUMN opening_reference text;
ALTER TABLE auth_effect_receipt DROP CONSTRAINT auth_credential_stage;
ALTER TABLE auth_effect_receipt ADD CONSTRAINT auth_credential_stage CHECK ((
  (operation_key IS NULL AND effect_reference IS NULL AND effect_digest IS NULL AND stage_version IS NULL
   AND stage_ciphertext IS NULL AND committed_result IS NULL AND committed_at IS NULL AND opening_receipt_id IS NULL)
  OR
  (operation_key IS NOT NULL AND effect_reference IS NOT NULL AND effect_digest ~ '^[a-f0-9]{64}$'
   AND stage_version=1 AND stage_ciphertext IS NOT NULL AND acting_human_id IS NOT NULL
   AND client_id IS NOT NULL AND scopes IS NOT NULL
   AND purpose IN ('set-password','remove-password','add-key','remove-key','add-passkey','remove-passkey')
   AND ((credential_row_id IS NULL) = (credential_row_version IS NULL))
   AND ((committed_at IS NULL AND committed_result IS NULL AND opening_receipt_id IS NULL)
     OR (committed_at IS NOT NULL AND opening_receipt_id IS NOT NULL
       AND committed_result = jsonb_build_object('receiptId',receipt_id,'replayed',false))))
) IS TRUE);

CREATE OR REPLACE FUNCTION auth_credential_stage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.operation_key IS NULL AND NEW.operation_key IS NOT NULL) OR
    (OLD.operation_key IS NOT NULL AND (
    (to_jsonb(NEW) - ARRAY['opening_receipt_id','opening_reference','committed_result','committed_at','minimum_authn_epoch'])
      IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['opening_receipt_id','opening_reference','committed_result','committed_at','minimum_authn_epoch'])
    OR OLD.committed_at IS NOT NULL
  )) THEN
    RAISE EXCEPTION 'Credential stage is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

-- migrate:down
-- Forward-only: credentials and effect receipts must survive retries.
