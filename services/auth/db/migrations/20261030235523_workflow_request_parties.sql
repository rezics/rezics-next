-- migrate:up
-- Unknown historical requests are never reconstructed from payloads or today's relations.
ALTER TABLE auth_workflow_request
  ADD COLUMN erasure_actor_id text CHECK(octet_length(erasure_actor_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_principal_id text CHECK(octet_length(erasure_principal_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_source_client_id text CHECK(octet_length(erasure_source_client_id) BETWEEN 1 AND 1024),
  ADD COLUMN request_party_version smallint NOT NULL DEFAULT 0 CHECK(request_party_version IN (0,1)),
  ADD COLUMN request_context_version smallint NOT NULL DEFAULT 0 CHECK(request_context_version IN (0,1)),
  ADD CONSTRAINT auth_request_party_context CHECK(request_party_version=0 OR
    (request_context_version=1 AND erasure_actor_version=1 AND erasure_actor_id IS NOT NULL
      AND erasure_source_client_id IS NOT NULL));
CREATE INDEX erasure_request_actor ON auth_workflow_request(erasure_actor_id,workflow_id);
CREATE INDEX erasure_request_principal ON auth_workflow_request(erasure_principal_id,workflow_id);
CREATE INDEX erasure_request_source_client ON auth_workflow_request(erasure_source_client_id,workflow_id);
CREATE INDEX erasure_request_unknown_context ON auth_workflow_request(workflow_id) WHERE request_party_version=0;

-- Original source roles are immutable, including inside their creation transaction.
-- Retiring a private request needs the existing native consumer proof, not SDK status.
CREATE FUNCTION auth_request_parties_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND
    ROW(NEW.erasure_subject_id,NEW.erasure_human_id,NEW.erasure_operator_id,
      NEW.erasure_client_id,NEW.erasure_member_id,NEW.erasure_previous_operator_id,
      NEW.erasure_stage_id,NEW.erasure_initiator_id,NEW.erasure_delegate_id,
      NEW.erasure_actor_version,NEW.erasure_actor_id,NEW.erasure_principal_id,
      NEW.erasure_source_client_id,NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id,
      NEW.request_party_version,NEW.request_context_version)
    IS DISTINCT FROM
    ROW(OLD.erasure_subject_id,OLD.erasure_human_id,OLD.erasure_operator_id,
      OLD.erasure_client_id,OLD.erasure_member_id,OLD.erasure_previous_operator_id,
      OLD.erasure_stage_id,OLD.erasure_initiator_id,OLD.erasure_delegate_id,
      OLD.erasure_actor_version,OLD.erasure_actor_id,OLD.erasure_principal_id,
      OLD.erasure_source_client_id,OLD.erasure_client_owner_id,OLD.erasure_source_client_owner_id,
      OLD.request_party_version,OLD.request_context_version) THEN
    RAISE EXCEPTION 'Auth request parties are immutable' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND NEW.request IS NOT DISTINCT FROM OLD.request
    AND NEW.digest IS NOT DISTINCT FROM OLD.digest AND NEW.terminal_at IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM auth_erasure_admit(NEW.erasure_actor_id);
  PERFORM auth_erasure_admit(NEW.erasure_principal_id);
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;
-- Runs after the native role trigger has filled original client-owner provenance.
CREATE TRIGGER zzz_request_parties BEFORE INSERT OR UPDATE ON auth_workflow_request
  FOR EACH ROW EXECUTE FUNCTION auth_request_parties_guard();

CREATE OR REPLACE FUNCTION auth_delete_workflow_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Exactly nativeRequestTerminal's registration closure. Other native consumers
  -- retain their pending request until their owning closure can retire it.
  DELETE FROM public.auth_workflow_request r
    USING public.auth_native_consumer_proof p
    WHERE r.workflow_id=OLD.workflow_uuid AND r.terminal_at IS NOT NULL
      AND r.request_party_version=1 AND r.request_context_version=1
      AND p.store='registration' AND p.key=r.erasure_stage_id
      AND p.binding->>1=r.workflow_id AND p.result->>'outcome' IN ('activated','expired');
  RETURN OLD;
END $$;

-- migrate:down
-- Forward only: historical provenance cannot be recovered after minimization.
