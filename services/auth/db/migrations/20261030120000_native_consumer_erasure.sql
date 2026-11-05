-- migrate:up
-- A native proof survives the source witness and DBOS history. It contains only
-- the original operation/effect binding and actual immutable native result.
CREATE TABLE auth_native_credential_terminal (
  receipt_id text PRIMARY KEY CHECK (octet_length(receipt_id)<=1024),
  obligation_id bigint NOT NULL REFERENCES auth_erasure(id),
  operation_key text NOT NULL,
  effect_reference text NOT NULL,
  effect_digest text NOT NULL CHECK (effect_digest ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL,
  minimum_authn_epoch integer NOT NULL,
  opening_receipt_id text,
  outcome text NOT NULL CHECK (outcome IN ('committed','fenced-refusal')),
  committed_result jsonb
);
CREATE FUNCTION auth_native_credential_terminal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Native credential terminal proof is immutable' USING ERRCODE='55000';
END $$;
CREATE TRIGGER auth_native_credential_terminal_immutable BEFORE UPDATE OR DELETE ON auth_native_credential_terminal
  FOR EACH ROW EXECUTE FUNCTION auth_native_credential_terminal_immutable();
-- The normal stage producer cannot reuse a terminal source identity, even after
-- physical cleanup. Existing role/client guards still fence newly allocated IDs.
CREATE FUNCTION auth_native_credential_terminal_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth_native_credential_terminal WHERE receipt_id=NEW.receipt_id) THEN
    RAISE EXCEPTION 'Native credential consumer is terminal' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_native_credential_terminal_fence BEFORE INSERT OR UPDATE ON auth_effect_receipt
  FOR EACH ROW EXECUTE FUNCTION auth_native_credential_terminal_fence();

ALTER TABLE auth_registration_stage ADD COLUMN consumer_workflow_id text;
ALTER TABLE auth_registration_stage ADD COLUMN activation_key text;
ALTER TABLE auth_registration_stage ADD COLUMN operator_reservation_id text;
ALTER TABLE auth_workflow_request ADD COLUMN erasure_stage_id text;
CREATE TABLE auth_native_consumer_proof (
  store text NOT NULL,
  key text NOT NULL CHECK (octet_length(key)<=1024),
  binding jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (store,key)
);
CREATE TRIGGER auth_native_consumer_proof_immutable BEFORE UPDATE OR DELETE ON auth_native_consumer_proof
  FOR EACH ROW EXECUTE FUNCTION auth_native_credential_terminal_immutable();
CREATE FUNCTION auth_native_registration_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consumer_workflow_id IS DISTINCT FROM OLD.consumer_workflow_id
    OR NEW.activation_key IS DISTINCT FROM OLD.activation_key
    OR (OLD.operator_reservation_id IS NOT NULL AND NEW.operator_reservation_id IS DISTINCT FROM OLD.operator_reservation_id) THEN
    RAISE EXCEPTION 'Native registration consumer identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER auth_native_registration_identity BEFORE UPDATE ON auth_registration_stage
  FOR EACH ROW EXECUTE FUNCTION auth_native_registration_identity();

ALTER TABLE auth_client_reduction_progress ADD COLUMN consumer_version smallint NOT NULL DEFAULT 0;
ALTER TABLE auth_client_reduction_progress ADD COLUMN page_count integer;
ALTER TABLE auth_client_reduction_progress ADD COLUMN completed_count integer NOT NULL DEFAULT 0;

-- migrate:down
-- Forward only: terminal native consumers must not regain producer authority.
