-- migrate:up
-- A new copy must have native provenance at creation. Existing rows stay unknown;
-- no descriptor/ciphertext inspection, role backfill or consumer completion.
ALTER TABLE auth_registration_stage
  ADD COLUMN creation_context_version smallint NOT NULL DEFAULT 0 CHECK (creation_context_version IN (0,1)),
  ADD COLUMN creation_scope_digest bytea CHECK (octet_length(creation_scope_digest)=32),
  ADD COLUMN creation_context jsonb,
  ADD COLUMN creation_approval_reference text CHECK (octet_length(creation_approval_reference) BETWEEN 1 AND 4096),
  ADD COLUMN erasure_actor_id text CHECK (octet_length(erasure_actor_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_human_id text CHECK (octet_length(erasure_human_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_principal_id text CHECK (octet_length(erasure_principal_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_native_operator_id text CHECK (octet_length(erasure_native_operator_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_client_id text CHECK (octet_length(erasure_client_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_source_client_id text CHECK (octet_length(erasure_source_client_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_client_owner_id text CHECK (octet_length(erasure_client_owner_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_source_client_owner_id text CHECK (octet_length(erasure_source_client_owner_id) BETWEEN 1 AND 1024);
CREATE INDEX creation_stage_actor ON auth_registration_stage(erasure_actor_id,registration_id);
CREATE INDEX creation_stage_human ON auth_registration_stage(erasure_human_id,registration_id);
CREATE INDEX creation_stage_principal ON auth_registration_stage(erasure_principal_id,registration_id);
CREATE INDEX creation_stage_native_operator ON auth_registration_stage(erasure_native_operator_id,registration_id);
CREATE INDEX creation_stage_client ON auth_registration_stage(erasure_client_id,registration_id);
CREATE INDEX creation_stage_source_client ON auth_registration_stage(erasure_source_client_id,registration_id);
CREATE INDEX creation_stage_client_owner ON auth_registration_stage(erasure_client_owner_id,registration_id);
CREATE INDEX creation_stage_source_client_owner ON auth_registration_stage(erasure_source_client_owner_id,registration_id);
CREATE INDEX creation_stage_unknown ON auth_registration_stage(registration_id) WHERE creation_context_version=0;
ALTER TABLE auth_provisioning_receipt
  ADD COLUMN creation_context_version smallint NOT NULL DEFAULT 0 CHECK (creation_context_version IN (0,1)),
  ADD COLUMN creation_scope_digest bytea CHECK (octet_length(creation_scope_digest)=32),
  ADD COLUMN creation_context jsonb,
  ADD COLUMN creation_approval_reference text CHECK (octet_length(creation_approval_reference) BETWEEN 1 AND 4096),
  ADD COLUMN erasure_actor_id text CHECK (octet_length(erasure_actor_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_human_id text CHECK (octet_length(erasure_human_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_principal_id text CHECK (octet_length(erasure_principal_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_native_operator_id text CHECK (octet_length(erasure_native_operator_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_client_id text CHECK (octet_length(erasure_client_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_source_client_id text CHECK (octet_length(erasure_source_client_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_client_owner_id text CHECK (octet_length(erasure_client_owner_id) BETWEEN 1 AND 1024),
  ADD COLUMN erasure_source_client_owner_id text CHECK (octet_length(erasure_source_client_owner_id) BETWEEN 1 AND 1024);
CREATE INDEX creation_receipt_actor ON auth_provisioning_receipt(erasure_actor_id,idempotency_key);
CREATE INDEX creation_receipt_human ON auth_provisioning_receipt(erasure_human_id,idempotency_key);
CREATE INDEX creation_receipt_principal ON auth_provisioning_receipt(erasure_principal_id,idempotency_key);
CREATE INDEX creation_receipt_native_operator ON auth_provisioning_receipt(erasure_native_operator_id,idempotency_key);
CREATE INDEX creation_receipt_client ON auth_provisioning_receipt(erasure_client_id,idempotency_key);
CREATE INDEX creation_receipt_source_client ON auth_provisioning_receipt(erasure_source_client_id,idempotency_key);
CREATE INDEX creation_receipt_client_owner ON auth_provisioning_receipt(erasure_client_owner_id,idempotency_key);
CREATE INDEX creation_receipt_source_client_owner ON auth_provisioning_receipt(erasure_source_client_owner_id,idempotency_key);
CREATE INDEX creation_receipt_unknown ON auth_provisioning_receipt(idempotency_key) WHERE creation_context_version=0;

-- The prior role marker covered only initiator/delegate. Do not let old rows
-- claim coverage of newly adopted source roles, even if an old marker was set.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth_registration_stage WHERE creation_context_version=0 LIMIT 1) THEN
    PERFORM auth_native_role_unknown('auth_registration_stage','historical-role-custody');
  END IF;
  IF EXISTS (SELECT 1 FROM auth_provisioning_receipt WHERE creation_context_version=0 LIMIT 1) THEN
    PERFORM auth_native_role_unknown('auth_provisioning_receipt','historical-role-custody');
  END IF;
END $$;

CREATE FUNCTION auth_creation_parties_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source auth_registration_stage%ROWTYPE; personal_id text; producer_client text;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.creation_context_version,NEW.creation_scope_digest,NEW.creation_context,NEW.creation_approval_reference,NEW.erasure_actor_id,NEW.erasure_human_id,NEW.erasure_principal_id,NEW.erasure_native_operator_id,NEW.erasure_client_id,NEW.erasure_source_client_id,NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id) IS DISTINCT FROM ROW(OLD.creation_context_version,OLD.creation_scope_digest,OLD.creation_context,OLD.creation_approval_reference,OLD.erasure_actor_id,OLD.erasure_human_id,OLD.erasure_principal_id,OLD.erasure_native_operator_id,OLD.erasure_client_id,OLD.erasure_source_client_id,OLD.erasure_client_owner_id,OLD.erasure_source_client_owner_id) THEN
      RAISE EXCEPTION 'Auth creation source is immutable' USING ERRCODE='55000';
    END IF;
    IF TG_TABLE_NAME='auth_registration_stage' THEN
      IF OLD.creation_context_version=1 AND (
        ROW(NEW.registration_id,NEW.request_key,NEW.account_id,NEW.handle,NEW.request_digest,
            NEW.erasure_creator_id,NEW.erasure_operator_id,NEW.erasure_initiator_id,NEW.erasure_delegate_id,NEW.erasure_actor_version)
        IS DISTINCT FROM
        ROW(OLD.registration_id,OLD.request_key,OLD.account_id,OLD.handle,OLD.request_digest,
            OLD.erasure_creator_id,OLD.erasure_operator_id,OLD.erasure_initiator_id,OLD.erasure_delegate_id,OLD.erasure_actor_version)
        OR (OLD.creation_context IS NOT NULL AND NEW.creation_binding IS DISTINCT FROM OLD.creation_binding)
      ) THEN RAISE EXCEPTION 'Auth creation request is immutable' USING ERRCODE='55000'; END IF;
      IF NEW.ciphertext IS NOT NULL AND NEW.ciphertext IS DISTINCT FROM OLD.ciphertext THEN
        IF NEW.creation_context_version<>1 THEN
          RAISE EXCEPTION 'Auth creation context unavailable: historical-provenance' USING ERRCODE='55000';
        END IF;
      ELSE RETURN NEW;
      END IF;
    ELSE RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME='auth_provisioning_receipt' THEN
    -- Exact source supplied by the native credential transaction, never a
    -- descriptor search. The old generic no-stage adapter stays unknown.
    IF NEW.erasure_stage_id IS NOT NULL THEN
      SELECT * INTO source FROM auth_registration_stage
        WHERE registration_id=NEW.erasure_stage_id AND account_id=NEW.account_id FOR UPDATE;
      IF NOT FOUND OR source.creation_context_version<>1
        OR NEW.creation_scope_digest IS DISTINCT FROM source.creation_scope_digest THEN
        RAISE EXCEPTION 'Auth creation receipt source unavailable' USING ERRCODE='55000';
      END IF;
      IF ROW(NEW.registration_id,NEW.reservation_id,NEW.expires_at) IS DISTINCT FROM
         ROW(source.reservation_id,source.reservation_id,source.expires_at) THEN
        RAISE EXCEPTION 'Auth creation receipt source binding refused' USING ERRCODE='55000';
      END IF;
      NEW.creation_context_version:=source.creation_context_version;
      NEW.creation_scope_digest:=source.creation_scope_digest;
      NEW.creation_context:=source.creation_context;
      NEW.creation_approval_reference:=source.creation_approval_reference;
      NEW.erasure_actor_id:=source.erasure_actor_id;
      NEW.erasure_human_id:=source.erasure_human_id;
      NEW.erasure_principal_id:=source.erasure_principal_id;
      NEW.erasure_native_operator_id:=source.erasure_native_operator_id;
      NEW.erasure_client_id:=source.erasure_client_id;
      NEW.erasure_source_client_id:=source.erasure_source_client_id;
      NEW.erasure_client_owner_id:=source.erasure_client_owner_id;
      NEW.erasure_source_client_owner_id:=source.erasure_source_client_owner_id;
      NEW.erasure_creator_id:=source.erasure_creator_id;
      NEW.erasure_operator_id:=source.erasure_operator_id;
      NEW.erasure_initiator_id:=source.erasure_initiator_id;
      NEW.erasure_delegate_id:=source.erasure_delegate_id;
      NEW.erasure_actor_version:=source.erasure_actor_version;
    ELSE
      IF EXISTS (SELECT 1 FROM auth_registration_stage WHERE account_id=NEW.account_id) OR
         NEW.creation_context_version<>0 OR NEW.creation_context IS NOT NULL THEN
        RAISE EXCEPTION 'Auth creation receipt source unavailable' USING ERRCODE='55000';
      END IF;
      PERFORM auth_native_role_unknown('auth_provisioning_receipt','source-unavailable');
      RETURN NEW;
    END IF;
  ELSE
    IF current_setting('auth.native_role_producer',true) IS DISTINCT FROM '1' OR
       NEW.creation_context_version<>1 THEN
      RAISE EXCEPTION 'Auth creation context unavailable: producer-missing' USING ERRCODE='55000';
    END IF;
  END IF;
  IF NEW.creation_scope_digest IS NULL OR NEW.erasure_actor_version<>1 THEN
    RAISE EXCEPTION 'Auth creation context binding refused' USING ERRCODE='55000';
  END IF;
  IF NEW.creation_context IS NULL THEN
    -- Public human registration has a preselected subject, with no authenticated
    -- approval actor, delegated principal, opening operator or source client.
    IF ROW(NEW.erasure_actor_id,NEW.erasure_human_id,NEW.erasure_principal_id,
       NEW.erasure_native_operator_id,NEW.erasure_client_id,NEW.erasure_source_client_id,
       NEW.creation_approval_reference,NEW.erasure_creator_id,NEW.erasure_operator_id,
       NEW.erasure_initiator_id,NEW.erasure_delegate_id) IS DISTINCT FROM
       ROW(NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,NULL::text,
           NULL::text,NULL::text,NULL::text,NULL::text,NULL::text) THEN
      RAISE EXCEPTION 'Auth public creation provenance refused' USING ERRCODE='55000';
    END IF;
  ELSE
    IF jsonb_typeof(NEW.creation_context)<>'object' OR
       NEW.erasure_actor_id IS NULL OR NEW.erasure_source_client_id IS NULL OR NEW.creation_approval_reference IS NULL OR
       ROW(NEW.erasure_actor_id,NEW.erasure_human_id,NEW.erasure_principal_id,NEW.erasure_native_operator_id,
           NEW.erasure_source_client_id,NEW.creation_approval_reference,NEW.erasure_client_id) IS DISTINCT FROM
       ROW(NEW.creation_context->>'actorAccountId',NEW.creation_context->>'actingHumanId',
           NEW.creation_context->>'principalAccountId',NEW.creation_context->>'operatorAccountId',
           NEW.creation_context->>'sourceClientId',NEW.creation_context->>'approvalReference',
           NEW.creation_context->'operation'->>'targetClientId') THEN
      RAISE EXCEPTION 'Auth approved creation provenance refused' USING ERRCODE='55000';
    END IF;
    IF TG_TABLE_NAME='auth_registration_stage' THEN
    IF (
       NEW.creation_binding->>'kind' IS DISTINCT FROM 'automated' OR
       NEW.creation_binding->>'operatorAccountId' IS DISTINCT FROM NEW.erasure_operator_id OR
       NEW.creation_binding->>'operationKey' IS DISTINCT FROM NEW.creation_context->>'operationKey' OR
       NEW.creation_context->'operation'->>'targetResourceId' IS DISTINCT FROM NEW.erasure_operator_id OR
       NEW.creation_context->'operation'->>'kind' IS DISTINCT FROM 'automated' OR
       NEW.creation_context->'operation'->>'action' IS DISTINCT FROM 'account:manage'
    ) THEN RAISE EXCEPTION 'Auth approved creation target refused' USING ERRCODE='55000'; END IF;
    END IF;
  END IF;
  FOREACH personal_id IN ARRAY ARRAY[NEW.account_id,NEW.erasure_creator_id,NEW.erasure_operator_id,NEW.erasure_initiator_id,NEW.erasure_delegate_id,NEW.erasure_actor_id,NEW.erasure_human_id,NEW.erasure_principal_id,NEW.erasure_native_operator_id,NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id] LOOP
    PERFORM auth_erasure_admit(personal_id);
  END LOOP;
  FOREACH producer_client IN ARRAY ARRAY[NEW.erasure_client_id,NEW.erasure_source_client_id] LOOP
    PERFORM auth_erasure_admit_client(producer_client);
  END LOOP;
  IF TG_OP='INSERT' AND TG_TABLE_NAME='auth_registration_stage' THEN
    SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW.erasure_client_id FOR SHARE;
    SELECT "userId" INTO NEW.erasure_source_client_owner_id FROM auth_client WHERE client_id=NEW.erasure_source_client_id FOR SHARE;
    -- The fixed deployment client can be ownerless. An absent source client is
    -- unavailable; only an actual public registration makes it inapplicable.
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT FOUND THEN
      RAISE EXCEPTION 'Auth creation source client unavailable' USING ERRCODE='55000';
    END IF;
    PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
    PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a_creation_parties BEFORE INSERT OR UPDATE ON auth_registration_stage
  FOR EACH ROW EXECUTE FUNCTION auth_creation_parties_guard();
CREATE TRIGGER a_creation_parties BEFORE INSERT OR UPDATE ON auth_provisioning_receipt
  FOR EACH ROW EXECUTE FUNCTION auth_creation_parties_guard();

-- migrate:down
-- Forward only: source attribution must not be silently discarded.
