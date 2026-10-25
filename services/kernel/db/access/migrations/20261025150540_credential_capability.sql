-- migrate:up
ALTER TABLE access.operator_opening_receipt
  ADD COLUMN credential_purpose text,
  ADD COLUMN credential_operation_key text,
  ADD COLUMN credential_effect_reference text,
  ADD COLUMN credential_effect_digest text,
  ADD CONSTRAINT credential_binding_closed CHECK (
    (credential_purpose IS NULL AND credential_operation_key IS NULL AND credential_effect_reference IS NULL AND credential_effect_digest IS NULL)
    OR (purpose = 'credential-management' AND credential_purpose IS NOT NULL
      AND credential_purpose IN ('set-password','remove-password','add-key','remove-key')
      AND credential_operation_key IS NOT NULL AND length(credential_operation_key) BETWEEN 1 AND 255
      AND credential_effect_reference IS NOT NULL AND length(credential_effect_reference) BETWEEN 1 AND 4096
      AND credential_effect_digest IS NOT NULL AND credential_effect_digest ~ '^[a-f0-9]{64}$'));
ALTER TABLE access.workflow_approval
  ADD COLUMN consumed_at timestamptz,
  ADD COLUMN consumed_transaction_id uuid,
  ADD CONSTRAINT credential_expiry CHECK (operation->>'kind' <> 'credential' OR expires_at <= created_at + interval '60 seconds');
CREATE OR REPLACE FUNCTION access.workflow_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.operation->>'kind' = 'credential' AND OLD.consumed_at IS NULL AND OLD.consumed_transaction_id IS NULL
    AND NEW.consumed_at IS NOT NULL AND NEW.consumed_transaction_id IS NOT NULL
    AND NEW.consumed_at >= OLD.created_at AND NEW.consumed_at < OLD.expires_at
    AND (to_jsonb(OLD) - 'consumed_at' - 'consumed_transaction_id') = (to_jsonb(NEW) - 'consumed_at' - 'consumed_transaction_id')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Workflow approvals are immutable';
END;
$$;
CREATE TABLE access.credential_floor_receipt (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  opening_receipt_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  operation_key text NOT NULL,
  effect_reference text NOT NULL,
  effect_digest text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('set-password','remove-password','remove-key')),
  previous_floor bigint NOT NULL CHECK (previous_floor > 0),
  minimum_authn_epoch bigint NOT NULL CHECK (minimum_authn_epoch = previous_floor + 1),
  fenced boolean NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, opening_receipt_id),
  CHECK (route = get_byte(uuid_send(account_id),10)*256 + get_byte(uuid_send(account_id),11))
);
-- migrate:down
CREATE OR REPLACE FUNCTION access.workflow_approval_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Workflow approvals are immutable'; END;
$$;
DROP TABLE access.credential_floor_receipt;
ALTER TABLE access.workflow_approval DROP CONSTRAINT credential_expiry, DROP COLUMN consumed_at, DROP COLUMN consumed_transaction_id;
ALTER TABLE access.operator_opening_receipt DROP CONSTRAINT credential_binding_closed,
  DROP COLUMN credential_purpose, DROP COLUMN credential_operation_key, DROP COLUMN credential_effect_reference, DROP COLUMN credential_effect_digest;
