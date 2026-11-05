-- migrate:up
-- Only exact original native consumers keep a full registration release witness.
-- These leading raw-key indexes also bound the final-reader checks on retention.
CREATE INDEX auth_native_proof_request_stage ON auth_workflow_request(erasure_stage_id,workflow_id);
CREATE INDEX auth_native_proof_provisioning_stage ON auth_provisioning_receipt(erasure_stage_id,idempotency_key);

CREATE FUNCTION auth_native_registration_readers(stage_key text) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM auth_registration_stage WHERE registration_id=stage_key)
    OR EXISTS(SELECT 1 FROM auth_provisioning_receipt WHERE erasure_stage_id=stage_key)
    OR EXISTS(SELECT 1 FROM auth_workflow_request WHERE erasure_stage_id=stage_key);
$$;

-- No new retired marker or payload hash. Expiry has permanent native command
-- refusal/replay and responsibility-slot evidence. Activation lacks an exported
-- committed-result reader once transient provisioning expires: keep its original
-- command/account identity and actual result, never null that last result.
CREATE FUNCTION auth_native_registration_skeleton(source_binding jsonb, source_result jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_array_length(CASE WHEN jsonb_typeof(source_binding)='array' THEN source_binding ELSE '[]'::jsonb END)=8
      AND source_result->>'outcome'='expired'
      AND source_result->'sourceResult'->>'accountId'=source_binding->>3
      AND source_result->'sourceResult'->>'kind'='tombstone'
      AND source_result->'sourceResult'->>'receiptId'<>''
      AND source_result->'sourceResult'->>'minimumAuthnEpoch' ~ '^[1-9][0-9]*$'
      AND source_result->'handleResult'=jsonb_build_object('accountId',source_binding->>3,'handle',source_binding->>4)
      AND (CASE WHEN source_binding->6='null'::jsonb THEN NOT source_result ? 'responsibilityResult'
        ELSE source_result->'responsibilityResult'=jsonb_build_object(
          'retired',jsonb_build_object('operatorAccountId',source_binding->>6,
            'subjectAccountId',source_binding->>3,'reservationId',source_binding->>7),
          'released',jsonb_build_object('operatorAccountId',source_binding->>6,
            'subjectAccountId',source_binding->>3,'reservationId',source_binding->>7)) END)
      THEN jsonb_build_object('outcome','expired')
    WHEN jsonb_array_length(CASE WHEN jsonb_typeof(source_binding)='array' THEN source_binding ELSE '[]'::jsonb END)=8
      AND source_result=jsonb_build_object('outcome','activated',
        'sourceResult',jsonb_build_object('accountId',source_binding->>3))
      THEN source_result
    ELSE NULL END;
$$;

CREATE FUNCTION auth_native_consumer_proof_minimize_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE skeleton jsonb; minimal_binding jsonb;
BEGIN
  IF TG_OP='UPDATE' AND OLD.store='registration' AND NEW.store=OLD.store AND NEW.key=OLD.key THEN
    skeleton:=auth_native_registration_skeleton(OLD.binding,OLD.result);
    minimal_binding:=CASE WHEN OLD.result->>'outcome'='expired' THEN 'null'::jsonb
      ELSE jsonb_build_array(OLD.binding->0,OLD.binding->1,OLD.binding->2,OLD.binding->3) END;
    IF skeleton IS NOT NULL AND NEW.binding=minimal_binding AND NEW.result=skeleton
      AND NOT auth_native_registration_readers(OLD.key) THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Native consumer terminal proof is immutable' USING ERRCODE='55000';
END $$;
DROP TRIGGER auth_native_consumer_proof_immutable ON auth_native_consumer_proof;
CREATE TRIGGER auth_native_consumer_proof_immutable BEFORE UPDATE OR DELETE ON auth_native_consumer_proof
  FOR EACH ROW EXECUTE FUNCTION auth_native_consumer_proof_minimize_guard();

CREATE FUNCTION auth_minimize_native_registration(stage_key text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE proof auth_native_consumer_proof; skeleton jsonb;
BEGIN
  IF stage_key IS NULL THEN RETURN; END IF;
  -- Lock before the separate dependency statement. Concurrent last-reader
  -- deletions serialize here; the waiter observes the previous commit as well.
  SELECT * INTO proof FROM auth_native_consumer_proof
    WHERE store='registration' AND key=stage_key FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  skeleton:=auth_native_registration_skeleton(proof.binding,proof.result);
  IF skeleton IS NULL OR auth_native_registration_readers(stage_key) THEN RETURN; END IF;
  UPDATE auth_native_consumer_proof SET
    binding=CASE WHEN proof.result->>'outcome'='expired' THEN 'null'::jsonb
      ELSE jsonb_build_array(proof.binding->0,proof.binding->1,proof.binding->2,proof.binding->3) END,
    result=skeleton WHERE store='registration' AND key=stage_key;
END $$;

CREATE FUNCTION auth_native_registration_reader_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM auth_minimize_native_registration(CASE WHEN TG_TABLE_NAME='auth_registration_stage'
    THEN to_jsonb(OLD)->>'registration_id' ELSE to_jsonb(OLD)->>'erasure_stage_id' END);
  RETURN OLD;
END $$;
CREATE TRIGGER native_proof_minimize AFTER DELETE ON auth_registration_stage
  FOR EACH ROW EXECUTE FUNCTION auth_native_registration_reader_deleted();
CREATE TRIGGER native_proof_minimize AFTER DELETE ON auth_provisioning_receipt
  FOR EACH ROW EXECUTE FUNCTION auth_native_registration_reader_deleted();
CREATE TRIGGER native_proof_minimize AFTER DELETE ON auth_workflow_request
  FOR EACH ROW EXECUTE FUNCTION auth_native_registration_reader_deleted();

-- Fence original producer identities independently of the removable binding.
-- The advisory lock closes the race between a first proof INSERT and a reader
-- INSERT that has not seen that proof yet. Existing readers may still finish.
CREATE FUNCTION auth_native_registration_producer_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stage_key text;
BEGIN
  stage_key:=CASE WHEN TG_TABLE_NAME='auth_registration_stage' THEN to_jsonb(NEW)->>'registration_id'
    ELSE to_jsonb(NEW)->>'erasure_stage_id' END;
  IF TG_OP='UPDATE' THEN
    IF to_jsonb(NEW)->>'erasure_stage_id' IS NOT DISTINCT FROM to_jsonb(OLD)->>'erasure_stage_id'
      THEN RETURN NEW; END IF;
    IF to_jsonb(OLD)->>'erasure_stage_id' IS NOT NULL THEN
      RAISE EXCEPTION 'Native registration reader identity is immutable' USING ERRCODE='55000';
    END IF;
  END IF;
  IF stage_key IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('auth-native-registration:'||stage_key,0));
  IF EXISTS(SELECT 1 FROM auth_native_consumer_proof WHERE store='registration' AND key=stage_key) THEN
    -- Preserve existing exact-key ON CONFLICT replay while its native reader
    -- remains. The row lock prevents a concurrent DELETE/reinsert resurrection.
    IF TG_TABLE_NAME='auth_workflow_request' THEN
      PERFORM 1 FROM auth_workflow_request WHERE workflow_id=NEW.workflow_id
        AND erasure_stage_id=stage_key FOR KEY SHARE;
      IF FOUND THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='auth_provisioning_receipt' THEN
      PERFORM 1 FROM auth_provisioning_receipt WHERE idempotency_key=NEW.idempotency_key
        AND erasure_stage_id=stage_key FOR KEY SHARE;
      IF FOUND THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'Native registration consumer is terminal' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aa_native_terminal_fence BEFORE INSERT ON auth_registration_stage
  FOR EACH ROW EXECUTE FUNCTION auth_native_registration_producer_fence();
CREATE TRIGGER aa_native_terminal_fence BEFORE INSERT OR UPDATE ON auth_provisioning_receipt
  FOR EACH ROW EXECUTE FUNCTION auth_native_registration_producer_fence();
CREATE TRIGGER aa_native_terminal_fence BEFORE INSERT OR UPDATE ON auth_workflow_request
  FOR EACH ROW EXECUTE FUNCTION auth_native_registration_producer_fence();

CREATE FUNCTION auth_native_registration_proof_insert_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.store='registration' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('auth-native-registration:'||NEW.key,0));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aa_native_proof_insert_lock BEFORE INSERT ON auth_native_consumer_proof
  FOR EACH ROW EXECUTE FUNCTION auth_native_registration_proof_insert_lock();
CREATE FUNCTION auth_native_registration_proof_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.store='registration' THEN PERFORM auth_minimize_native_registration(NEW.key); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER native_proof_minimize AFTER INSERT ON auth_native_consumer_proof
  FOR EACH ROW EXECUTE FUNCTION auth_native_registration_proof_inserted();

-- migrate:down
-- Forward only: minimized private bindings cannot be restored.
