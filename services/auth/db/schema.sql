--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: auth_assert_session_capacity(text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_assert_session_capacity(owner_id text, serialize boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE ready boolean;
BEGIN
  IF serialize THEN
    SELECT sessions_bounded INTO ready FROM "user" WHERE id=owner_id FOR UPDATE;
  ELSE
    SELECT sessions_bounded INTO ready FROM "user" WHERE id=owner_id;
  END IF;
  IF ready IS false THEN
    RAISE EXCEPTION 'Session history upgrade required' USING ERRCODE='55000';
  END IF;
END $$;


--
-- Name: auth_barrier_proof_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_barrier_proof_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(NEW) - 'applied_at') IS DISTINCT FROM (to_jsonb(OLD) - 'applied_at')
    OR OLD.applied_at IS NOT NULL OR NEW.applied_at IS NULL THEN
    RAISE EXCEPTION 'Barrier evidence is immutable';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_configuration_client_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_configuration_client_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- These fields have no admitted personal producer or active native consumer.
  NEW.contacts := NULL; NEW.name := NULL; NEW.uri := NULL; NEW.icon := NULL;
  NEW.tos := NULL; NEW.policy := NULL; NEW."softwareId" := NULL;
  NEW."softwareVersion" := NULL; NEW."softwareStatement" := NULL;
  IF TG_OP='INSERT' THEN
    NEW.metadata := NULL;
    NEW."referenceId" := NULL;
    NEW.display_name_writer := NULL;
  ELSE
    NEW.display_name_writer := OLD.display_name_writer;
    IF OLD.display_name_writer=1 THEN
      IF octet_length(NEW.display_name)>400 THEN
        NEW.display_name_writer := NULL;
      ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
        NEW.display_name_writer := NULL;
      END IF;
    END IF;
    -- There is no admitted source retiring a legacy provider reference.
    NEW."referenceId" := OLD."referenceId";
    IF OLD.metadata IS NULL THEN
      NEW.metadata := NULL;
    ELSIF NEW.metadata IS NULL THEN
      IF NEW.client_id='rezics-website'
        AND current_setting('auth.configuration_client',true) IS DISTINCT FROM NEW.client_id THEN
        RAISE EXCEPTION 'Auth website metadata requires configuration replacement' USING ERRCODE='55000';
      END IF;
    ELSE
      -- Never compare, traverse or detoast the old JSON to classify a write.
      -- A non-null attempted replacement cannot install a new private value.
      NEW.metadata := OLD.metadata;
    END IF;
  END IF;
  -- The command supplies the actual configured key and label, never a caller's
  -- assertion that arbitrary JSON is safe. Transaction-local settings expire.
  IF current_setting('auth.configuration_client',true)=NEW.client_id
    AND current_setting('auth.configuration_label',true)=NEW.display_name THEN
    NEW.display_name_writer := 1;
  END IF;
  IF NEW.display_name_writer IS DISTINCT FROM 1 THEN NEW.display_name := NULL; END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_configuration_link_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_configuration_link_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.metadata := NULL;
  RETURN NEW;
END $$;


--
-- Name: auth_configuration_resource_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_configuration_resource_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.metadata := NULL;
  IF TG_OP='INSERT' THEN
    NEW."customClaims" := NULL;
    NEW.name_writer := NULL;
  ELSE
    NEW.name_writer := OLD.name_writer;
    IF OLD.name_writer=1 THEN
      IF NEW.name IS DISTINCT FROM 'REZICS API' OR NEW.id IS DISTINCT FROM OLD.id
        OR NEW.identifier IS DISTINCT FROM OLD.identifier THEN NEW.name_writer := NULL; END IF;
    END IF;
    IF OLD."customClaims" IS NULL THEN
      NEW."customClaims" := NULL;
    ELSIF NEW."customClaims" IS NULL THEN
      IF current_setting('auth.configuration_resource',true) IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Auth resource claims require configuration replacement' USING ERRCODE='55000';
      END IF;
    ELSE
      NEW."customClaims" := OLD."customClaims";
    END IF;
  END IF;
  IF current_setting('auth.configuration_resource',true)=NEW.id AND NEW.name='REZICS API' THEN
    NEW.name_writer := 1;
  END IF;
  IF NEW.name_writer IS DISTINCT FROM 1 THEN NEW.name := ''; NEW.name_writer := 0; END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_consent_revision(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_consent_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.revision := OLD.revision + CASE WHEN NEW.scopes IS DISTINCT FROM OLD.scopes THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;


--
-- Name: auth_copy_native_fence_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_copy_native_fence_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.sdk_fence_generation IS NOT NULL THEN
      RAISE EXCEPTION 'Auth native writer receipt is permanent' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.sdk_fence_generation IS NOT NULL AND (
    ROW(NEW.workflow_id,NEW.name,NEW.version,NEW.scope_count,NEW.parent_workflow_id,
      NEW.ready,NEW.source_key,NEW.result_digest,NEW.result_finished_at,NEW.sdk_fence_generation,NEW.sdk_fence_closure_id,NEW.sdk_fence_closed_at)
    IS DISTINCT FROM ROW(OLD.workflow_id,OLD.name,OLD.version,OLD.scope_count,OLD.parent_workflow_id,
      OLD.ready,OLD.source_key,OLD.result_digest,OLD.result_finished_at,OLD.sdk_fence_generation,OLD.sdk_fence_closure_id,OLD.sdk_fence_closed_at)
    OR (OLD.retired AND NOT NEW.retired) OR (OLD.absent AND NOT NEW.absent)) THEN
    RAISE EXCEPTION 'Auth native writer receipt is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.retired AND NOT OLD.retired AND NEW.sdk_fence_generation IS NULL THEN
    RAISE EXCEPTION 'Auth native writer receipt is missing' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_copy_record(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_copy_record() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE work text; locator text; size integer; old_size integer; existed boolean; current_work auth_copy_work; cap integer;
BEGIN
  IF TG_TABLE_NAME='notifications' THEN
    work:=NEW.destination_uuid; locator:=NEW.message_uuid;
  ELSE
    work:=NEW.workflow_uuid;
    IF TG_TABLE_NAME='operation_outputs' THEN locator:=NEW.function_id::text;
    ELSIF TG_TABLE_NAME='workflow_events' THEN locator:=NEW.key;
    ELSIF TG_TABLE_NAME='workflow_events_history' THEN locator:=NEW.function_id::text||':'||NEW.key;
    ELSIF TG_TABLE_NAME='streams' THEN RAISE EXCEPTION 'Auth stream copy is undeclared' USING ERRCODE='55000';
    ELSE locator:=''; END IF;
  END IF;
  SELECT * INTO current_work FROM auth_copy_work WHERE workflow_id=work FOR UPDATE;
  IF NOT FOUND THEN
    -- The two maintenance workflows have a closed counts-only contract. Every
    -- personal workflow (including a child) must already have complete scope.
    IF TG_TABLE_NAME='workflow_status' THEN
      IF NEW.name IN ('auth.maintenance.tick','auth.workflowRetention') THEN RETURN NEW; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM auth_dbos.workflow_status WHERE workflow_uuid=work AND name IN ('auth.maintenance.tick','auth.workflowRetention')) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Auth copy custody missing' USING ERRCODE='55000';
  END IF;
  IF current_work.retired THEN
    IF TG_OP='UPDATE' AND TG_TABLE_NAME='workflow_status' THEN
      IF NEW.status='CANCELLED' AND NEW.owner_xid IS NULL AND
        (to_jsonb(NEW)-ARRAY['status','owner_xid','queue_name','deduplication_id','started_at_epoch_ms','updated_at','completed_at']) =
        (to_jsonb(OLD)-ARRAY['status','owner_xid','queue_name','deduplication_id','started_at_epoch_ms','updated_at','completed_at']) THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'Auth copy work retired' USING ERRCODE='55000';
  END IF;
  IF (SELECT count(*) FROM auth_copy_role WHERE workflow_id=work)<>current_work.scope_count THEN
    RAISE EXCEPTION 'Auth copy role coverage missing' USING ERRCODE='55000';
  END IF;
  size:=octet_length(row_to_json(NEW)::text);
  IF size>(CASE WHEN TG_TABLE_NAME='workflow_status' THEN 4096 ELSE 65536 END) THEN
    RAISE EXCEPTION 'Auth copy byte cap' USING ERRCODE='54000';
  END IF;
  IF TG_TABLE_NAME='streams' THEN RAISE EXCEPTION 'Auth stream copy is undeclared' USING ERRCODE='55000'; END IF;
  SELECT true,bytes INTO existed,old_size FROM auth_copy_artifact WHERE workflow_id=work AND kind=TG_TABLE_NAME AND key=locator;
  IF existed IS DISTINCT FROM true THEN
    cap:=CASE TG_TABLE_NAME WHEN 'operation_outputs' THEN 60 WHEN 'workflow_events' THEN 8 WHEN 'workflow_events_history' THEN 64 WHEN 'notifications' THEN 4 ELSE 1 END;
    IF (SELECT count(*) FROM auth_copy_artifact WHERE workflow_id=work AND kind=TG_TABLE_NAME)>=cap THEN
      RAISE EXCEPTION 'Auth copy row cap' USING ERRCODE='54000';
    END IF;
    UPDATE auth_copy_work SET rows=rows+1,bytes=bytes+size WHERE workflow_id=work;
  END IF;
  IF existed AND size>old_size THEN UPDATE auth_copy_work SET bytes=bytes+size-old_size WHERE workflow_id=work; END IF;
  INSERT INTO auth_copy_artifact(workflow_id,kind,key,bytes) VALUES(work,TG_TABLE_NAME,locator,size)
    ON CONFLICT(workflow_id,kind,key) DO UPDATE SET bytes=GREATEST(auth_copy_artifact.bytes,EXCLUDED.bytes);
  RETURN NEW;
END $$;


--
-- Name: auth_copy_result_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_copy_result_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.retired AND NEW.absent AND NEW.source_key IS NULL AND
    (NEW.result_digest IS NULL OR NEW.result_digest=decode(repeat('00',32),'hex')) AND
    NEW.result_finished_at IS NOT DISTINCT FROM OLD.result_finished_at THEN RETURN NEW; END IF;
  IF NEW.source_key IS DISTINCT FROM OLD.source_key OR (OLD.result_finished_at IS NOT NULL AND
    (NEW.result_finished_at IS DISTINCT FROM OLD.result_finished_at OR NEW.result_digest IS DISTINCT FROM OLD.result_digest)) THEN
    RAISE EXCEPTION 'Auth native result commitment is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_copy_role_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_copy_role_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' OR NOT EXISTS(SELECT 1 FROM auth_copy_work WHERE workflow_id=OLD.workflow_id AND retired AND absent) THEN
    RAISE EXCEPTION 'Auth copy role custody is immutable' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
END $$;


--
-- Name: auth_creation_parties_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_creation_parties_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: auth_credential_stage_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_credential_stage_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: auth_delete_workflow_request(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_delete_workflow_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: auth_erasure_admit(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_admit(owner_id text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF owner_id IS NULL OR owner_id='' THEN RETURN; END IF;
  -- Only the native bounded deployment page installs this transaction context.
  -- Its trigger accepts version-only updates, never a new artifact or role move.
  IF current_setting('auth.native_role_reconcile',true)='1' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth-erasure:'||owner_id,0));
  IF EXISTS (SELECT 1 FROM auth_erasure WHERE account_id=owner_id)
    AND NOT EXISTS (SELECT 1 FROM auth_erasure WHERE account_id=owner_id
      AND id::text=current_setting('auth.erasure_obligation',true)) THEN
    RAISE EXCEPTION 'Auth erasure fence' USING ERRCODE='55000';
  END IF;
END $$;


--
-- Name: auth_erasure_admit_client(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_admit_client(client text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE owner_id text; fenced boolean;
BEGIN
  IF client IS NULL THEN RETURN; END IF;
  IF current_setting('auth.native_role_reconcile',true)='1' THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('auth-client:'||client,0));
  SELECT "userId",erasure_fenced INTO owner_id,fenced FROM auth_client WHERE client_id=client;
  IF EXISTS (SELECT 1 FROM auth_erased_client WHERE client_id=client
      AND obligation_id::text IS DISTINCT FROM current_setting('auth.erasure_obligation',true)) THEN
    RAISE EXCEPTION 'Auth erased client fence' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(owner_id);
  IF fenced AND NOT EXISTS (SELECT 1 FROM auth_erasure WHERE account_id=owner_id
      AND id::text=current_setting('auth.erasure_obligation',true)) THEN
    RAISE EXCEPTION 'Auth client erasure fence' USING ERRCODE='55000';
  END IF;
  RETURN;
END $$;


--
-- Name: auth_erasure_client_empty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_client_empty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM session WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthAccessToken" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthRefreshToken" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthRefreshFamily" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM "oauthClientResource" WHERE "clientId"=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_consent WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_client_coverage WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_client_reduction WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_client_reduction_progress WHERE client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_workflow_request WHERE erasure_source_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_registration_stage WHERE erasure_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_registration_stage WHERE erasure_source_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_provisioning_receipt WHERE erasure_client_id=OLD.client_id)
    OR EXISTS (SELECT 1 FROM auth_provisioning_receipt WHERE erasure_source_client_id=OLD.client_id) THEN
    RAISE EXCEPTION 'Auth native client children remain' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;


--
-- Name: auth_erasure_establishment_roles(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_establishment_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT erasure_client_id,erasure_source_client_id,erasure_human_id,erasure_operator_id
    INTO NEW.erasure_client_id,NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id
    FROM auth_barrier_proof WHERE reference=NEW.reference;
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."userId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_attempt_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_attempt_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_barrier_proof(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_barrier_proof() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_client(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_client() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."userId");
  PERFORM auth_erasure_admit_client(OLD.client_id);
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  PERFORM auth_erasure_admit_client(NEW.client_id);
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_client_coverage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_client_coverage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_client_reduction(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_client_reduction() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_client_reduction_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_client_reduction_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_consent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_consent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_effect_receipt(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_effect_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD."acting_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW."acting_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."client_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_key_assertion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_key_assertion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_provisioning_receipt(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_provisioning_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE source_stage text;
BEGIN
  IF TG_OP='INSERT' THEN
    -- The stage's unique native account binding establishes these roles in the
    -- credential/receipt transaction. No encrypted payload or request JSON walk.
    source_stage:=NEW.erasure_stage_id;
    IF source_stage IS NOT NULL THEN
      SELECT registration_id,erasure_creator_id,erasure_operator_id
      INTO NEW.erasure_stage_id,NEW.erasure_creator_id,NEW.erasure_operator_id
      FROM auth_registration_stage WHERE registration_id=source_stage AND account_id=NEW.account_id FOR KEY SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Auth source registration missing' USING ERRCODE='55000'; END IF;
    ELSE
      SELECT registration_id,erasure_creator_id,erasure_operator_id
      INTO NEW.erasure_stage_id,NEW.erasure_creator_id,NEW.erasure_operator_id
      FROM auth_registration_stage WHERE account_id=NEW.account_id FOR KEY SHARE;
    END IF;
  END IF;
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD.erasure_creator_id);
  PERFORM auth_erasure_admit(OLD.erasure_operator_id);
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW.erasure_creator_id);
  PERFORM auth_erasure_admit(NEW.erasure_operator_id);
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_public_key(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_public_key() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_recent_oidc_session(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_recent_oidc_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_recovery(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_recovery() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_recovery_establishment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_recovery_establishment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD.erasure_human_id);
  PERFORM auth_erasure_admit(OLD.erasure_operator_id);
  PERFORM auth_erasure_admit_client(OLD.erasure_client_id);
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW.erasure_human_id);
  PERFORM auth_erasure_admit(NEW.erasure_operator_id);
  PERFORM auth_erasure_admit_client(NEW.erasure_client_id);
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_registration_stage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_registration_stage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.ciphertext IS NULL AND NEW.credential_digest IS NULL
    AND (to_jsonb(NEW)-ARRAY['ciphertext','credential_digest'])=(to_jsonb(OLD)-ARRAY['ciphertext','credential_digest'])
    AND EXISTS (SELECT 1 FROM auth_erasure e
      WHERE e.id=NULLIF(current_setting('auth.erasure_obligation',true),'')::bigint
        AND e.account_id IN (OLD.account_id,OLD.erasure_creator_id,OLD.erasure_operator_id)) THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.erasure_release_at IS NOT NULL
    AND (to_jsonb(NEW)-'erasure_release_at')=(to_jsonb(OLD)-'erasure_release_at') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."account_id");
  PERFORM auth_erasure_admit(OLD."erasure_creator_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."account_id");
  PERFORM auth_erasure_admit(NEW."erasure_creator_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_auth_session_opening(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_auth_session_opening() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."subject_account_id");
  PERFORM auth_erasure_admit(OLD."acting_human_id");
  PERFORM auth_erasure_admit(OLD."operator_account_id");
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."subject_account_id");
  PERFORM auth_erasure_admit(NEW."acting_human_id");
  PERFORM auth_erasure_admit(NEW."operator_account_id");
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_oauthaccesstoken(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_oauthaccesstoken() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."userId");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."clientId");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_oauthclientassertion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_oauthclientassertion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_oauthclientresource(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_oauthclientresource() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit_client(NEW."clientId");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_oauthrefreshfamily(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_oauthrefreshfamily() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."erasure_account_id");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit(NEW."erasure_account_id");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."clientId");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_oauthrefreshtoken(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_oauthrefreshtoken() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."userId");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."clientId");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_passkey(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_passkey() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."userId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_request(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.request IS NOT DISTINCT FROM OLD.request
     AND NEW.digest IS NOT DISTINCT FROM OLD.digest
     AND (NEW.erasure_subject_id,NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_client_id,NEW.erasure_member_id,NEW.erasure_previous_operator_id)
       IS NOT DISTINCT FROM (OLD.erasure_subject_id,OLD.erasure_human_id,OLD.erasure_operator_id,OLD.erasure_client_id,OLD.erasure_member_id,OLD.erasure_previous_operator_id)
     AND NEW.terminal_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' THEN
    PERFORM auth_erasure_admit(OLD.erasure_member_id);
    PERFORM auth_erasure_admit(OLD.erasure_previous_operator_id);
    PERFORM auth_erasure_admit(OLD.erasure_subject_id);
    PERFORM auth_erasure_admit(OLD.erasure_human_id);
    PERFORM auth_erasure_admit(OLD.erasure_operator_id);
    PERFORM auth_erasure_admit_client(OLD.erasure_client_id);
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_member_id);
  PERFORM auth_erasure_admit(NEW.erasure_previous_operator_id);
  PERFORM auth_erasure_admit(NEW.erasure_subject_id);
  PERFORM auth_erasure_admit(NEW.erasure_human_id);
  PERFORM auth_erasure_admit(NEW.erasure_operator_id);
  PERFORM auth_erasure_admit_client(NEW.erasure_client_id);
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_session(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."userId");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."clientId");
  END IF;
  PERFORM auth_erasure_admit(NEW."userId");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."clientId");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_user() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit(OLD."id");
  END IF;
  PERFORM auth_erasure_admit(NEW."id");
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_guard_verification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_guard_verification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
  PERFORM auth_erasure_admit_client(OLD.erasure_source_client_id);
  PERFORM auth_erasure_admit(OLD."erasure_account_id");
  PERFORM auth_erasure_admit(OLD."erasure_human_id");
  PERFORM auth_erasure_admit(OLD."erasure_operator_id");
  PERFORM auth_erasure_admit_client(OLD."erasure_client_id");
  END IF;
  PERFORM auth_erasure_admit(NEW."erasure_account_id");
  PERFORM auth_erasure_admit(NEW."erasure_human_id");
  PERFORM auth_erasure_admit(NEW."erasure_operator_id");
  PERFORM auth_erasure_admit_client(NEW."erasure_client_id");
  PERFORM auth_erasure_admit_client(NEW.erasure_source_client_id);
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_opening_roles(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_opening_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT "clientId" INTO NEW.erasure_client_id FROM session WHERE id=NEW.session_id;
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_opening_session(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_opening_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE session SET erasure_human_id=NEW.acting_human_id,erasure_operator_id=NEW.operator_account_id WHERE id=NEW.session_id;
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_proof_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_proof_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.barrier IS DISTINCT FROM OLD.barrier
    OR (OLD.kernel_at IS NOT NULL AND (NEW.kernel_at IS DISTINCT FROM OLD.kernel_at OR NEW.kernel_version IS DISTINCT FROM OLD.kernel_version))
    OR (OLD.source_accepted_at IS NOT NULL AND (NEW.source_continuation_id IS DISTINCT FROM OLD.source_continuation_id OR NEW.source_receipt_id IS DISTINCT FROM OLD.source_receipt_id OR NEW.source_accepted_at IS DISTINCT FROM OLD.source_accepted_at OR NEW.source_workflow_id IS DISTINCT FROM OLD.source_workflow_id))
    OR (OLD.source_discharged_at IS NOT NULL AND NEW.source_discharged_at IS DISTINCT FROM OLD.source_discharged_at)
    OR (OLD.copies_completed_at IS NOT NULL AND NEW.copies_completed_at IS DISTINCT FROM OLD.copies_completed_at) THEN
    RAISE EXCEPTION 'Auth erasure proof is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_proof_roles(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_proof_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.purpose='consent-reduction' AND NEW.evidence->>0='consent-v1' THEN
    NEW.erasure_session_id:=NEW.evidence->>3;
    NEW.erasure_client_id:=NEW.evidence->>8;
    NEW.erasure_source_client_id:=NEW.evidence->>4;
    SELECT erasure_human_id,erasure_operator_id INTO NEW.erasure_human_id,NEW.erasure_operator_id
      FROM session WHERE id=NEW.erasure_session_id;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_recent_roles(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_recent_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT "clientId",erasure_human_id,erasure_operator_id
    INTO NEW.erasure_client_id,NEW.erasure_human_id,NEW.erasure_operator_id FROM session WHERE id=NEW.session_id;
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_session_roles(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_session_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT acting_human_id,operator_account_id INTO NEW.erasure_human_id,NEW.erasure_operator_id
    FROM auth_session_opening WHERE session_id=NEW.id;
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_token_roles(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_token_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT "clientId",erasure_human_id,erasure_operator_id
    INTO NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id
    FROM session WHERE id=NEW."sessionId" FOR KEY SHARE;
  IF NEW."sessionId" IS NOT NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'Auth source session missing' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_erasure_user_empty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_user_empty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM session WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM passkey WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_client WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM "oauthAccessToken" WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM "oauthRefreshToken" WHERE "userId"=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_public_key WHERE account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_key_assertion WHERE account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_recovery WHERE account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_barrier_proof WHERE account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_session_opening WHERE subject_account_id=OLD.id)
    OR EXISTS (SELECT 1 FROM auth_provisioning_receipt WHERE owner_id=OLD.id) THEN
    RAISE EXCEPTION 'Auth native user children remain' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;


--
-- Name: auth_erasure_verification_roles(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_erasure_verification_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.erasure_account_id IS NOT NULL AND
     (NEW.erasure_account_id,NEW.erasure_client_id,NEW.erasure_session_id,NEW.erasure_source_client_id) IS DISTINCT FROM
     (OLD.erasure_account_id,OLD.erasure_client_id,OLD.erasure_session_id,OLD.erasure_source_client_id) THEN
    RAISE EXCEPTION 'Auth verification attribution is immutable';
  END IF;
  IF NEW.erasure_session_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.erasure_session_id IS NULL) THEN
    SELECT "clientId",erasure_human_id,erasure_operator_id
      INTO NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id
      FROM session WHERE id=NEW.erasure_session_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Auth source session missing' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_kind_consent_dependency_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_kind_consent_dependency_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('auth-kind-consent-frontier',0));
    IF EXISTS (
      SELECT 1 FROM auth_kind_consent_transition t
      WHERE t.state<>'applied' AND (t.transition_kind='restore' OR
        (t.client_id=NEW.client_id AND (t.account_id IS NULL OR t.account_id=NEW.account_id)))
    ) THEN
      RAISE EXCEPTION 'Kind consent enrollment frontier is closed' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.active THEN RAISE EXCEPTION 'Active Kind consent dependency cannot be erased' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.reference_id,NEW.consumer_key_hash,NEW.account_id,NEW.client_id,NEW.requested_scopes,
           NEW.effective_scopes,NEW.consent_revision,NEW.client_scopes,NEW.client_first_party,NEW.consumer_route,NEW.owner_account_id,
           NEW.collection_id,NEW.preparation_id,NEW.origin_id,NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.reference_id,OLD.consumer_key_hash,OLD.account_id,OLD.client_id,OLD.requested_scopes,
           OLD.effective_scopes,OLD.consent_revision,OLD.client_scopes,OLD.client_first_party,OLD.consumer_route,OLD.owner_account_id,
           OLD.collection_id,OLD.preparation_id,OLD.origin_id,OLD.created_at) THEN
      RAISE EXCEPTION 'Kind consent consumer binding is immutable' USING ERRCODE='23514';
    END IF;
    IF (NOT OLD.active AND NEW.active) OR
       (OLD.fenced_transition_id IS NOT NULL AND ROW(NEW.fenced_transition_id,NEW.receipt_reference,NEW.fenced_at)
         IS DISTINCT FROM ROW(OLD.fenced_transition_id,OLD.receipt_reference,OLD.fenced_at)) THEN
      RAISE EXCEPTION 'Kind consent dependency fence is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF OLD.active AND NOT NEW.active THEN
    IF NEW.fenced_transition_id IS NULL OR NEW.receipt_reference IS NULL OR NEW.fenced_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM auth_kind_consent_transition t
      WHERE t.transition_id=NEW.fenced_transition_id AND t.state='pending'
        AND (t.transition_kind='restore' OR (t.client_id=OLD.client_id AND (t.account_id IS NULL OR t.account_id=OLD.account_id)))
        AND OLD.enrollment_seq<=t.frontier_seq
        AND current_setting('auth.kind_consent_transition_id',true)=t.transition_id::text
    ) THEN RAISE EXCEPTION 'Kind consent dependency fence is unverified' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_kind_consent_transition_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_kind_consent_transition_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  transition auth_kind_consent_transition%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.transition_id,NEW.transition_key,NEW.transition_kind,NEW.client_id,NEW.account_id,NEW.target,NEW.frontier_seq,NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.transition_id,OLD.transition_key,OLD.transition_kind,OLD.client_id,OLD.account_id,OLD.target,OLD.frontier_seq,OLD.created_at) THEN
      RAISE EXCEPTION 'Kind consent transition identity is immutable' USING ERRCODE='23514';
    END IF;
    IF NEW.after_seq<OLD.after_seq OR
       (OLD.state='pending' AND NEW.state NOT IN ('pending','ready')) OR
       (OLD.state='ready' AND NEW.state NOT IN ('ready','applied')) OR
       OLD.state='applied' AND ROW(NEW.after_seq,NEW.state,NEW.updated_at,NEW.applied_at)
         IS DISTINCT FROM ROW(OLD.after_seq,OLD.state,OLD.updated_at,OLD.applied_at) THEN
      RAISE EXCEPTION 'Kind consent transition progress is invalid' USING ERRCODE='23514';
    END IF;
    IF NEW.state IN ('ready','applied') AND EXISTS (
      SELECT 1 FROM auth_kind_consent_dependency d
      WHERE d.active AND (NEW.transition_kind='restore' OR
        (d.client_id=NEW.client_id AND (NEW.account_id IS NULL OR d.account_id=NEW.account_id)))
        AND d.enrollment_seq<=NEW.frontier_seq
    ) THEN
      RAISE EXCEPTION 'Kind consent transition has unfenced consumers' USING ERRCODE='23514';
    END IF;
    IF NEW.state='applied' AND OLD.state<>'ready' THEN
      RAISE EXCEPTION 'Kind consent transition was not ready' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.state<>'applied' THEN RAISE EXCEPTION 'Kind consent transition is unresolved' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;


--
-- Name: auth_kind_consent_writer_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_kind_consent_writer_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  account_key text;
  client_key text;
  operation text;
  transition auth_kind_consent_transition%ROWTYPE;
  required boolean := false;
  authority_change boolean := false;
BEGIN
  IF TG_TABLE_NAME='auth_consent' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    account_key:=CASE WHEN TG_OP='DELETE' THEN OLD.account_id ELSE NEW.account_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=OLD.account_id AND d.client_id=OLD.client_id);
      operation:='consent-delete';
    ELSIF TG_OP='INSERT' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=NEW.account_id AND d.client_id=NEW.client_id);
      operation:='consent-upsert';
    ELSE
      authority_change:=ROW(NEW.scopes,NEW.pending_scopes,NEW.pending_reference) IS DISTINCT FROM ROW(OLD.scopes,OLD.pending_scopes,OLD.pending_reference);
      required:=authority_change
        AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=NEW.account_id AND d.client_id=NEW.client_id);
      operation:=CASE WHEN NEW.scopes IS NOT DISTINCT FROM OLD.scopes THEN 'consent-pending' ELSE 'consent-upsert' END;
    END IF;
  ELSIF TG_TABLE_NAME='auth_client' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    ELSE
      authority_change:=ROW(NEW.scopes,NEW.first_party,NEW.erasure_fenced,NEW.disabled) IS DISTINCT FROM ROW(OLD.scopes,OLD.first_party,OLD.erasure_fenced,OLD.disabled);
      required:=authority_change
        AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    END IF;
    operation:=CASE WHEN TG_OP='UPDATE' AND
      ROW(NEW.disabled,NEW.erasure_fenced) IS DISTINCT FROM ROW(OLD.disabled,OLD.erasure_fenced)
      THEN 'client-erasure-fence' ELSE 'client-config' END;
  ELSIF TG_TABLE_NAME='auth_client_reduction' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    authority_change:=TG_OP<>'UPDATE';
    required:=authority_change AND EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    operation:=CASE WHEN TG_OP='DELETE' THEN 'client-reduction-finish' ELSE 'client-reduction-start' END;
  ELSIF TG_TABLE_NAME='auth_client_coverage' THEN
    client_key:=CASE WHEN TG_OP='DELETE' THEN OLD.client_id ELSE NEW.client_id END;
    IF TG_OP='DELETE' THEN
      authority_change:=true;
      required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    ELSE
      authority_change:=(TG_OP='INSERT' AND NEW.ready) OR
        (TG_OP='UPDATE' AND NEW.ready IS DISTINCT FROM OLD.ready);
      required:=authority_change AND
        EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key);
    END IF;
    operation:='client-coverage';
  ELSE
    RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF NOT authority_change THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  -- This is the database-side serialization point for legacy/direct writers.
  -- A direct mutation cannot race an enrollment snapshot or slip through after
  -- a page has fenced its rows but before the exact transition is applied.
  PERFORM pg_advisory_xact_lock(hashtextextended('auth-kind-consent-frontier',0));
  IF TG_TABLE_NAME='auth_consent' THEN
    required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.account_id=account_key AND d.client_id=client_key)
      OR EXISTS(SELECT 1 FROM auth_kind_consent_transition t WHERE t.state<>'applied' AND
        (t.transition_kind='restore' OR (t.client_id=client_key AND (t.account_id IS NULL OR t.account_id=account_key))));
  ELSE
    required:=EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key)
      OR EXISTS(SELECT 1 FROM auth_kind_consent_transition t WHERE t.state<>'applied' AND
        (t.transition_kind='restore' OR (t.client_id=client_key AND (t.account_id IS NULL OR t.account_id=account_key))));
  END IF;
  IF NOT required THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  SELECT * INTO transition FROM auth_kind_consent_transition t
  WHERE t.transition_id::text=current_setting('auth.kind_consent_transition_id',true)
    AND t.state='ready' AND t.client_id=client_key
    AND (t.account_id IS NULL OR t.account_id=account_key)
    AND (t.target->>'operation'=operation OR
      (TG_TABLE_NAME='auth_client_coverage' AND TG_OP='INSERT' AND operation='client-coverage'
       AND t.target->>'operation'='client-config'));
  IF NOT FOUND THEN RAISE EXCEPTION 'Kind consent dependency closure required before Auth write' USING ERRCODE='55000'; END IF;
  IF EXISTS(SELECT 1 FROM auth_kind_consent_dependency d WHERE d.active AND d.client_id=client_key
      AND (transition.account_id IS NULL OR d.account_id=transition.account_id)
      AND d.enrollment_seq<=transition.frontier_seq) THEN
    RAISE EXCEPTION 'Kind consent dependency closure is incomplete' USING ERRCODE='55000';
  END IF;
  IF TG_TABLE_NAME='auth_consent' THEN
    IF operation='consent-upsert' AND TG_OP<>'DELETE' THEN
      IF transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
        (transition.target ? 'pendingScopes' AND transition.target->'pendingScopes' IS DISTINCT FROM COALESCE(to_jsonb(NEW.pending_scopes),'null'::jsonb)) OR
        (transition.target ? 'pendingReference' AND transition.target->>'pendingReference' IS DISTINCT FROM NEW.pending_reference) THEN
        RAISE EXCEPTION 'Kind consent transition target mismatch' USING ERRCODE='23514';
      END IF;
    ELSIF operation='consent-pending' AND TG_OP='UPDATE' THEN
      IF transition.target->'pendingScopes' IS DISTINCT FROM to_jsonb(NEW.pending_scopes) OR
        transition.target->>'pendingReference' IS DISTINCT FROM NEW.pending_reference THEN
        RAISE EXCEPTION 'Kind pending consent transition target mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='auth_client' THEN
    IF TG_OP='UPDATE' THEN
      IF operation='client-config' THEN
        IF transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
          transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(NEW.first_party)#>>'{}' THEN
          RAISE EXCEPTION 'Kind client transition target mismatch' USING ERRCODE='23514';
        END IF;
      ELSIF operation='client-erasure-fence' AND (NOT NEW.erasure_fenced OR NOT NEW.disabled) THEN
        RAISE EXCEPTION 'Kind client erasure fence target mismatch' USING ERRCODE='23514';
      END IF;
    ELSIF TG_OP='DELETE' AND transition.target->>'operation'<>'client-delete' THEN
      RAISE EXCEPTION 'Kind client deletion transition target mismatch' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='auth_client_coverage' THEN
    IF TG_OP<>'DELETE' THEN
      IF transition.target->>'operation'='client-coverage' AND
        transition.target->>'ready' IS DISTINCT FROM to_jsonb(NEW.ready)#>>'{}' THEN
        RAISE EXCEPTION 'Kind client coverage transition target mismatch' USING ERRCODE='23514';
      ELSIF TG_OP='INSERT' AND transition.target->>'operation'='client-config' AND
        (NOT NEW.ready OR NOT EXISTS(
          SELECT 1 FROM auth_client c WHERE c.client_id=client_key
            AND to_jsonb(c.scopes)=transition.target->'scopes'
            AND (to_jsonb(c.first_party)#>>'{}')=transition.target->>'firstParty'
        )) THEN
        RAISE EXCEPTION 'Kind client coverage is outside client transition target' USING ERRCODE='23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME='auth_client_reduction' THEN
    IF TG_OP='INSERT' THEN
      IF transition.target->>'operationId' IS DISTINCT FROM NEW.operation_id OR
        transition.target->'scopes' IS DISTINCT FROM to_jsonb(NEW.scopes) OR
        transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(NEW.first_party)#>>'{}' THEN
        RAISE EXCEPTION 'Kind client reduction start target mismatch' USING ERRCODE='23514';
      END IF;
    ELSIF TG_OP='DELETE' THEN
      IF transition.target->>'operationId' IS DISTINCT FROM OLD.operation_id OR
        transition.target->'scopes' IS DISTINCT FROM to_jsonb(OLD.scopes) OR
        transition.target->>'firstParty' IS DISTINCT FROM to_jsonb(OLD.first_party)#>>'{}' THEN
        RAISE EXCEPTION 'Kind client reduction finish target mismatch' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;


--
-- Name: auth_minimize_native_registration(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_minimize_native_registration(stage_key text) RETURNS void
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: auth_native_consumer_proof_minimize_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_consumer_proof_minimize_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: auth_native_credential_terminal_fence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_credential_terminal_fence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth_native_credential_terminal WHERE receipt_id=NEW.receipt_id) THEN
    RAISE EXCEPTION 'Native credential consumer is terminal' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_credential_terminal_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_credential_terminal_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Native credential terminal proof is immutable' USING ERRCODE='55000';
END $$;


--
-- Name: auth_native_phase_coverage_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_phase_coverage_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.native_covered AND current_setting('auth.native_phase_producer',true) IS DISTINCT FROM '3' THEN
    RAISE EXCEPTION 'Auth native phase producer version refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_phase_cursor_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_phase_cursor_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='INSERT' OR NULLIF(current_setting('auth.erasure_obligation',true),'') IS NOT NULL OR
     ROW(NEW.phase,NEW.client_phase,NEW.after_key,NEW.client_id,NEW.native_phase_version,
         NEW.native_completed_at,NEW.native_role_version) IS DISTINCT FROM
     ROW(OLD.phase,OLD.client_phase,OLD.after_key,OLD.client_id,OLD.native_phase_version,
         OLD.native_completed_at,OLD.native_role_version) THEN
    IF current_setting('auth.native_phase_worker',true) IS DISTINCT FROM '3' THEN
      RAISE EXCEPTION 'Auth native phase worker version refused' USING ERRCODE='55000';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND NEW.native_phase_version<OLD.native_phase_version THEN
    RAISE EXCEPTION 'Auth native phase downgrade refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_phase_producer_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_phase_producer_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- This lock crosses processes and survives a pool restart. The old native
  -- role triggers remain responsible for original source custody and history.
  PERFORM 1 FROM auth_native_phase_deployment WHERE singleton AND version=3 FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Auth native phase deployment unavailable' USING ERRCODE='55000'; END IF;
  IF NULLIF(current_setting('auth.erasure_obligation',true),'') IS NOT NULL THEN
    IF current_setting('auth.native_phase_worker',true) IS DISTINCT FROM '3' THEN
      RAISE EXCEPTION 'Auth native phase worker version refused' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP<>'DELETE' AND current_setting('auth.native_phase_producer',true) IS DISTINCT FROM '3'
    AND current_setting('auth.native_role_reconcile',true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Auth native phase producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_phase_upgrade_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_phase_upgrade_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.native_phase_upgrade IS NOT NULL AND NEW.native_phase_upgrade IS DISTINCT FROM OLD.native_phase_upgrade THEN
    RAISE EXCEPTION 'Auth native phase upgrade evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_registration_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_registration_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.consumer_workflow_id IS DISTINCT FROM OLD.consumer_workflow_id
    OR NEW.activation_key IS DISTINCT FROM OLD.activation_key
    OR (OLD.operator_reservation_id IS NOT NULL AND NEW.operator_reservation_id IS DISTINCT FROM OLD.operator_reservation_id) THEN
    RAISE EXCEPTION 'Native registration consumer identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_registration_producer_fence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_registration_producer_fence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: auth_native_registration_proof_insert_lock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_registration_proof_insert_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.store='registration' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('auth-native-registration:'||NEW.key,0));
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_registration_proof_inserted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_registration_proof_inserted() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.store='registration' THEN PERFORM auth_minimize_native_registration(NEW.key); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_registration_reader_deleted(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_registration_reader_deleted() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM auth_minimize_native_registration(CASE WHEN TG_TABLE_NAME='auth_registration_stage'
    THEN to_jsonb(OLD)->>'registration_id' ELSE to_jsonb(OLD)->>'erasure_stage_id' END);
  RETURN OLD;
END $$;


--
-- Name: auth_native_registration_readers(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_registration_readers(stage_key text) RETURNS boolean
    LANGUAGE sql
    AS $$
  SELECT EXISTS(SELECT 1 FROM auth_registration_stage WHERE registration_id=stage_key)
    OR EXISTS(SELECT 1 FROM auth_provisioning_receipt WHERE erasure_stage_id=stage_key)
    OR EXISTS(SELECT 1 FROM auth_workflow_request WHERE erasure_stage_id=stage_key);
$$;


--
-- Name: auth_native_registration_skeleton(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_registration_skeleton(source_binding jsonb, source_result jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    AS $_$
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
$_$;


--
-- Name: auth_native_request_party_version_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_request_party_version_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- The original ABI deliberately retains historical version zero. It is not
  -- a current producer claim and can never certify native coverage.
  IF NEW.request_party_version=0 THEN
    PERFORM auth_native_role_unknown('auth_workflow_request','unsupported-producer-format');
  ELSIF NEW.request_context_version<>1 OR NEW.erasure_actor_version<>1 THEN
    RAISE EXCEPTION 'Auth native request party producer version refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId") IS DISTINCT FROM ROW(OLD."userId") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('account',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_attempt_account(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_attempt_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id") IS DISTINCT FROM ROW(OLD."account_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_attempt_account',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_barrier_proof(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_barrier_proof() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_barrier_proof','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW.erasure_session_id IS NOT NULL THEN SELECT erasure_client_owner_id,erasure_role_version INTO NEW.erasure_source_client_owner_id,source_version FROM session WHERE id=NEW.erasure_session_id FOR KEY SHARE; covered:=FOUND AND source_version=1; END IF;
    covered:=covered AND (NEW.purpose<>'consent-reduction' OR NEW.erasure_session_id IS NOT NULL);
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_barrier_proof',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_client(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_client() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_client',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_client_coverage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_client_coverage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_client_coverage','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_client_coverage',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_client_reduction(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_client_reduction() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_client_reduction','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_client_reduction',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_client_reduction_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_client_reduction_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_client_reduction_progress','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_client_reduction_progress',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_consent(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_consent() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_consent','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_consent',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_effect_receipt(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_effect_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_effect_receipt','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=fresh OR NEW.stage_version=1;
    IF NEW."client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."acting_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."acting_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_effect_receipt',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_key_assertion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_key_assertion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id") IS DISTINCT FROM ROW(OLD."account_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_key_assertion',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_provisioning_receipt(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_provisioning_receipt() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_provisioning_receipt','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW.erasure_stage_id IS NOT NULL THEN
      SELECT erasure_delegate_id,erasure_initiator_id,erasure_actor_version,erasure_role_version
        INTO NEW.erasure_delegate_id,NEW.erasure_initiator_id,NEW.erasure_actor_version,source_version
        FROM auth_registration_stage WHERE registration_id=NEW.erasure_stage_id AND account_id=NEW.account_id FOR KEY SHARE;
      covered:=FOUND AND source_version=1;
    ELSE covered:=false;
    END IF;
    covered:=covered AND (NEW.erasure_stage_id IS NULL OR NEW.erasure_actor_version=1);
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_delegate_id":=COALESCE(OLD."erasure_delegate_id",NEW."erasure_delegate_id");
      NEW."erasure_initiator_id":=COALESCE(OLD."erasure_initiator_id",NEW."erasure_initiator_id");
    END IF;
    NEW.erasure_actor_version:=COALESCE(NEW.erasure_actor_version,CASE WHEN TG_OP='UPDATE' THEN OLD.erasure_actor_version ELSE 0 END);
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_creator_id",NEW."erasure_operator_id",NEW."erasure_delegate_id",NEW."erasure_initiator_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_creator_id",OLD."erasure_operator_id",OLD."erasure_delegate_id",OLD."erasure_initiator_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_delegate_id);
  PERFORM auth_erasure_admit(NEW.erasure_initiator_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_provisioning_receipt',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_public_key(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_public_key() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id") IS DISTINCT FROM ROW(OLD."account_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_public_key',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_recent_oidc_session(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_recent_oidc_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_recent_oidc_session','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    SELECT "clientId",erasure_human_id,erasure_operator_id,erasure_client_owner_id,erasure_role_version INTO NEW.erasure_client_id,NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_client_owner_id,source_version FROM session WHERE id=NEW.session_id AND "userId"=NEW.account_id FOR KEY SHARE;
    covered:=FOUND AND source_version=1;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_client_id":=COALESCE(OLD."erasure_client_id",NEW."erasure_client_id");
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_client_owner_id":=COALESCE(OLD."erasure_client_owner_id",NEW."erasure_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_recent_oidc_session',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_recovery(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_recovery() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id") IS DISTINCT FROM ROW(OLD."account_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_recovery',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_recovery_establishment(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_recovery_establishment() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_recovery_establishment','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    SELECT erasure_client_id,erasure_source_client_id,erasure_human_id,erasure_operator_id,erasure_client_owner_id,erasure_source_client_owner_id,erasure_role_version
      INTO NEW.erasure_client_id,NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id,source_version
      FROM auth_barrier_proof WHERE reference=NEW.reference AND account_id=NEW.account_id FOR KEY SHARE;
    covered:=FOUND AND source_version=1;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_client_id":=COALESCE(OLD."erasure_client_id",NEW."erasure_client_id");
      NEW."erasure_source_client_id":=COALESCE(OLD."erasure_source_client_id",NEW."erasure_source_client_id");
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_client_owner_id":=COALESCE(OLD."erasure_client_owner_id",NEW."erasure_client_owner_id");
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_recovery_establishment',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_registration_stage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_registration_stage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_registration_stage','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.erasure_actor_version=1;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."account_id",NEW."erasure_creator_id",NEW."erasure_operator_id",NEW."erasure_delegate_id",NEW."erasure_initiator_id") IS DISTINCT FROM ROW(OLD."account_id",OLD."erasure_creator_id",OLD."erasure_operator_id",OLD."erasure_delegate_id",OLD."erasure_initiator_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_delegate_id);
  PERFORM auth_erasure_admit(NEW.erasure_initiator_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_registration_stage',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_session_opening(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_session_opening() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_session_opening','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.subject_account_id IS NOT NULL AND NEW.acting_human_id IS NOT NULL AND NEW.operator_account_id IS NOT NULL;
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    SELECT erasure_client_owner_id INTO NEW.erasure_client_owner_id FROM session WHERE id=NEW.session_id AND "userId"=NEW.subject_account_id FOR KEY SHARE; covered:=covered AND FOUND;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_client_owner_id":=COALESCE(OLD."erasure_client_owner_id",NEW."erasure_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."subject_account_id",NEW."acting_human_id",NEW."operator_account_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id") IS DISTINCT FROM ROW(OLD."subject_account_id",OLD."acting_human_id",OLD."operator_account_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_session_opening',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_auth_workflow_request(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_auth_workflow_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT (TG_OP='DELETE' AND pg_trigger_depth()>1 AND EXISTS(SELECT 1 FROM auth_copy_work WHERE workflow_id=OLD.workflow_id AND ready AND retired)) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('auth_workflow_request','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.erasure_actor_version=1;
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_subject_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_member_id",NEW."erasure_previous_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_delegate_id",NEW."erasure_initiator_id",NEW."erasure_client_id") IS DISTINCT FROM ROW(OLD."erasure_subject_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_member_id",OLD."erasure_previous_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_delegate_id",OLD."erasure_initiator_id",OLD."erasure_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT (TG_OP='UPDATE' AND NEW.terminal_at IS NOT NULL AND NEW.request IS NOT DISTINCT FROM OLD.request AND NEW.digest IS NOT DISTINCT FROM OLD.digest) THEN PERFORM auth_erasure_admit(NEW.erasure_client_owner_id); END IF;
  IF NOT (TG_OP='UPDATE' AND NEW.terminal_at IS NOT NULL AND NEW.request IS NOT DISTINCT FROM OLD.request AND NEW.digest IS NOT DISTINCT FROM OLD.digest) THEN PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id); END IF;
  IF NOT (TG_OP='UPDATE' AND NEW.terminal_at IS NOT NULL AND NEW.request IS NOT DISTINCT FROM OLD.request AND NEW.digest IS NOT DISTINCT FROM OLD.digest) THEN PERFORM auth_erasure_admit(NEW.erasure_delegate_id); END IF;
  IF NOT (TG_OP='UPDATE' AND NEW.terminal_at IS NOT NULL AND NEW.request IS NOT DISTINCT FROM OLD.request AND NEW.digest IS NOT DISTINCT FROM OLD.digest) THEN PERFORM auth_erasure_admit(NEW.erasure_initiator_id); END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('auth_workflow_request',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_finish_oauthclientassertion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_finish_oauthclientassertion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE "oauthClientAssertion" SET erasure_role_version=0 WHERE id=NEW.id AND erasure_role_version=0;
  RETURN NULL;
END $$;


--
-- Name: auth_native_role_finish_verification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_finish_verification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE "verification" SET erasure_role_version=0 WHERE id=NEW.id AND erasure_role_version=0;
  RETURN NULL;
END $$;


--
-- Name: auth_native_role_oauthaccesstoken(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_oauthaccesstoken() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthAccessToken','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."sessionId" IS NOT NULL THEN
      SELECT erasure_human_id,erasure_operator_id,"clientId",erasure_client_owner_id,erasure_role_version
        INTO NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_source_client_id,NEW.erasure_source_client_owner_id,source_version
        FROM session WHERE id=NEW."sessionId" AND "userId"=NEW."userId" FOR KEY SHARE;
      covered:=FOUND AND source_version=1;
    ELSE covered:=fresh;
    END IF;
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_source_client_id":=COALESCE(OLD."erasure_source_client_id",NEW."erasure_source_client_id");
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."userId",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthAccessToken',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_oauthclientassertion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_oauthclientassertion() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthClientAssertion','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.erasure_client_id IS NOT NULL;
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  IF fresh AND TG_OP='INSERT' AND NOT COALESCE(covered,false) THEN NEW.erasure_role_version:=0;
  ELSE NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END; END IF;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthClientAssertion',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_oauthclientresource(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_oauthclientresource() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthClientResource','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId") IS DISTINCT FROM ROW(OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthClientResource',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_oauthrefreshfamily(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_oauthrefreshfamily() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthRefreshFamily','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    SELECT erasure_account_id,erasure_human_id,erasure_operator_id,erasure_source_client_id,
      erasure_source_client_owner_id,erasure_role_version
      INTO NEW.erasure_account_id,NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_source_client_id,
        NEW.erasure_source_client_owner_id,source_version
      -- Resolve the same newest winner as the pinned native consume. Never
      -- scan older protocol history looking for a matching client.
      FROM (SELECT erasure_account_id,erasure_human_id,erasure_operator_id,erasure_source_client_id,
        erasure_source_client_owner_id,erasure_role_version,erasure_client_id
        FROM verification WHERE identifier=NEW.id
        ORDER BY "createdAt" DESC,id DESC LIMIT 1 FOR KEY SHARE) source
      WHERE source.erasure_client_id=NEW."clientId";
    covered:=FOUND AND source_version=1;
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_account_id":=COALESCE(OLD."erasure_account_id",NEW."erasure_account_id");
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_source_client_id":=COALESCE(OLD."erasure_source_client_id",NEW."erasure_source_client_id");
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."erasure_account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthRefreshFamily',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_oauthrefreshtoken(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_oauthrefreshtoken() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('oauthRefreshToken','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    IF NEW."sessionId" IS NOT NULL THEN
      SELECT erasure_human_id,erasure_operator_id,"clientId",erasure_client_owner_id,erasure_role_version
        INTO NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_source_client_id,NEW.erasure_source_client_owner_id,source_version
        FROM session WHERE id=NEW."sessionId" AND "userId"=NEW."userId" FOR KEY SHARE;
      covered:=FOUND AND source_version=1;
    ELSE covered:=fresh;
    END IF;
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
      NEW."erasure_source_client_id":=COALESCE(OLD."erasure_source_client_id",NEW."erasure_source_client_id");
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."userId",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('oauthRefreshToken',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_passkey(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_passkey() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId") IS DISTINCT FROM ROW(OLD."userId") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('passkey',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_session(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('session','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    SELECT acting_human_id,operator_account_id INTO NEW.erasure_human_id,NEW.erasure_operator_id FROM auth_session_opening WHERE session_id=NEW.id AND subject_account_id=NEW."userId";
    covered:=fresh OR FOUND;
    IF NEW."clientId" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."clientId" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_human_id":=COALESCE(OLD."erasure_human_id",NEW."erasure_human_id");
      NEW."erasure_operator_id":=COALESCE(OLD."erasure_operator_id",NEW."erasure_operator_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."userId",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."clientId") IS DISTINCT FROM ROW(OLD."userId",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."clientId") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('session',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_unknown(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_unknown(source_store text, reason_code text) RETURNS void
    LANGUAGE sql
    AS $$
  INSERT INTO auth_native_role_unknown(store,reason) VALUES(source_store,reason_code) ON CONFLICT DO NOTHING;
  UPDATE auth_copy_coverage SET native_covered=false WHERE singleton AND native_covered;
$$;


--
-- Name: auth_native_role_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_user() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."id") IS DISTINCT FROM ROW(OLD."id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('user',CASE WHEN fresh THEN 'source-unavailable' ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_native_role_verification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_native_role_verification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE fresh boolean; covered boolean:=true; source_version smallint; source_owner text;
BEGIN
  fresh:=current_setting('auth.native_role_producer',true)='1';
  IF NOT COALESCE(fresh,false) AND NOT EXISTS(SELECT 1 FROM auth_native_role_deployment WHERE singleton AND NOT armed FOR KEY SHARE NOWAIT) THEN
    RAISE EXCEPTION 'Auth native role producer version refused' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN
    IF OLD.erasure_role_version=0 THEN PERFORM auth_native_role_unknown('verification','historical-role-custody'); END IF;
    RETURN OLD;
  END IF;
  fresh:=COALESCE(fresh,false) AND (TG_OP='INSERT' OR OLD.erasure_role_xid=txid_current());
  IF TG_OP='INSERT' THEN NEW.erasure_role_xid:=CASE WHEN fresh THEN txid_current() END; END IF;
  IF TG_OP='INSERT' OR OLD.erasure_role_version=0 THEN
    covered:=NEW.erasure_account_id IS NOT NULL OR (fresh AND NEW.erasure_format='webauthn-anonymous-v1');
    IF NEW.erasure_session_id IS NOT NULL THEN
      SELECT erasure_role_version,erasure_client_owner_id INTO source_version,NEW.erasure_source_client_owner_id FROM session WHERE id=NEW.erasure_session_id AND "userId"=NEW.erasure_account_id FOR KEY SHARE;
      covered:=covered AND FOUND AND source_version=1;
    END IF;
    IF NEW."erasure_client_id" IS NOT NULL THEN
      IF fresh THEN
        SELECT "userId" INTO NEW.erasure_client_owner_id FROM auth_client WHERE client_id=NEW."erasure_client_id" FOR KEY SHARE;
        covered:=covered AND FOUND;
      ELSE covered:=false;
      END IF;
    END IF;
    IF NEW.erasure_source_client_id IS NOT NULL AND NOT fresh THEN covered:=false; END IF;
    IF TG_OP='UPDATE' AND NOT fresh THEN
      NEW."erasure_source_client_owner_id":=COALESCE(OLD."erasure_source_client_owner_id",NEW."erasure_source_client_owner_id");
    END IF;
  ELSE
    covered:=OLD.erasure_role_version=1;
  END IF;
  IF fresh AND TG_OP='INSERT' AND NOT COALESCE(covered,false) THEN NEW.erasure_role_version:=0;
  ELSE NEW.erasure_role_version:=CASE WHEN COALESCE(covered,false) THEN 1 ELSE -1 END; END IF;
  IF TG_OP='UPDATE' AND OLD.erasure_role_version<>0 AND NOT fresh AND
    ROW(NEW."erasure_account_id",NEW."erasure_human_id",NEW."erasure_operator_id",NEW."erasure_client_owner_id",NEW."erasure_source_client_owner_id",NEW."erasure_client_id",NEW."erasure_source_client_id") IS DISTINCT FROM ROW(OLD."erasure_account_id",OLD."erasure_human_id",OLD."erasure_operator_id",OLD."erasure_client_owner_id",OLD."erasure_source_client_owner_id",OLD."erasure_client_id",OLD."erasure_source_client_id") THEN
    RAISE EXCEPTION 'Auth native role custody is immutable' USING ERRCODE='55000';
  END IF;
  PERFORM auth_erasure_admit(NEW.erasure_client_owner_id);
  PERFORM auth_erasure_admit(NEW.erasure_source_client_owner_id);
  IF NEW.erasure_role_version=-1 AND (TG_OP='INSERT' OR OLD.erasure_role_version=0) THEN PERFORM auth_native_role_unknown('verification',CASE WHEN fresh THEN CASE WHEN NEW.erasure_format='unknown' THEN 'unsupported-producer-format' ELSE 'source-unavailable' END ELSE 'historical-role-custody' END); END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_passkey_used(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_passkey_used() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.last_used_at := statement_timestamp();
  RETURN NEW;
END $$;


--
-- Name: auth_provisioning_receipt_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_provisioning_receipt_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Provisioning receipts are immutable';
END;
$$;


--
-- Name: auth_receiving_copy_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_receiving_copy_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN RAISE EXCEPTION 'Auth receiving SDK receipt is immutable'; END $$;


--
-- Name: auth_receiving_work_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_receiving_work_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth receiving work is permanent'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.native_xid IS NOT NULL OR NEW.closure_receipt_id IS NOT NULL OR NEW.closure_xid IS NOT NULL THEN
   RAISE EXCEPTION 'Auth receiving work must start without completion';
  END IF;
 ELSE
  IF (NEW.obligation_id,NEW.control_revision,NEW.binding,NEW.restore_generation)
   IS DISTINCT FROM (OLD.obligation_id,OLD.control_revision,OLD.binding,OLD.restore_generation)
   OR (OLD.native_xid IS NOT NULL AND NEW.native_xid IS DISTINCT FROM OLD.native_xid)
   OR (NEW.native_xid IS NOT NULL AND OLD.native_xid IS NULL AND NEW.native_xid<>pg_current_xact_id())
   OR (NEW.closure_xid IS NOT NULL AND OLD.closure_xid IS NULL AND NEW.closure_xid<>pg_current_xact_id())
   OR (OLD.closure_receipt_id IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'Auth receiving work cannot replace its binding or completed receipt';
  END IF;
 END IF;
 RETURN NEW;
END $$;


--
-- Name: auth_recovery_copy_capture(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_recovery_copy_capture() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE source verification%ROWTYPE; owner_id text;
BEGIN
  -- The source is the native INSERT in THIS transaction, not a later observation
  -- or a caller-supplied role/version/settings assertion. Derive every role and
  -- timestamp from its exact key. Never copy identifier, value or their hashes.
  SELECT id,value,erasure_account_id,erasure_human_id,erasure_operator_id,erasure_client_owner_id,
    erasure_source_client_owner_id,erasure_role_xid,erasure_role_version,erasure_format,"createdAt","expiresAt"
    INTO source.id,source.value,source.erasure_account_id,source.erasure_human_id,source.erasure_operator_id,
      source.erasure_client_owner_id,source.erasure_source_client_owner_id,source.erasure_role_xid,
      source.erasure_role_version,source.erasure_format,source."createdAt",source."expiresAt"
    FROM verification WHERE id=NEW.delivery_id;
  IF NOT FOUND OR source.erasure_role_xid IS DISTINCT FROM txid_current()
    OR source.erasure_role_version<>1 OR source.erasure_format IS DISTINCT FROM 'reset-v1'
    OR source.erasure_account_id IS NULL OR source.erasure_account_id IS DISTINCT FROM source.value THEN
    RAISE EXCEPTION 'Auth recovery Source provenance unavailable' USING ERRCODE='55000';
  END IF;
  NEW.account_id:=source.erasure_account_id;
  NEW.erasure_human_id:=source.erasure_human_id;
  NEW.erasure_operator_id:=source.erasure_operator_id;
  NEW.erasure_client_owner_id:=source.erasure_client_owner_id;
  NEW.erasure_source_client_owner_id:=source.erasure_source_client_owner_id;
  NEW.created_at:=source."createdAt";
  NEW.expires_at:=source."expiresAt";
  NEW.erasure_role_xid:=source.erasure_role_xid;
  NEW.erasure_role_version:=1;
  IF NEW.status<>'intent' OR NEW.attempts<>0 OR NEW.attempted_at IS NOT NULL
    OR NEW.code<>'receiving-adapter-unavailable' THEN
    RAISE EXCEPTION 'Auth recovery Source must begin at intent' USING ERRCODE='55000';
  END IF;
  FOREACH owner_id IN ARRAY ARRAY[NEW.account_id,NEW.erasure_human_id,NEW.erasure_operator_id,
      NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id] LOOP
    PERFORM auth_erasure_admit(owner_id);
    IF EXISTS(SELECT 1 FROM auth_erasure WHERE account_id=owner_id) THEN
      RAISE EXCEPTION 'Auth erasure fence' USING ERRCODE='55000';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;


--
-- Name: auth_recovery_copy_producer_cut(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_recovery_copy_producer_cut() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Native role projection finishes after INSERT but inside its supported
  -- adapter transaction. This commit-time guard refuses old reset writers.
  IF EXISTS(SELECT 1 FROM verification WHERE id=NEW.id AND erasure_format='reset-v1'
      AND erasure_role_xid=txid_current())
    AND NOT EXISTS(SELECT 1 FROM auth_recovery_copy_source WHERE delivery_id=NEW.id) THEN
    RAISE EXCEPTION 'Auth recovery Source producer unavailable' USING ERRCODE='55000';
  END IF;
  RETURN NULL;
END $$;


--
-- Name: auth_recovery_copy_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_recovery_copy_progress() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE owner_id text;
BEGIN
  -- Only a receiving owner's durable verified disposition could authorize
  -- minimization. There is no such installed adapter in this Source slice.
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Auth recovery receiving disposition unavailable' USING ERRCODE='55000';
  END IF;
  IF ROW(NEW.delivery_id,NEW.producer,NEW.source_component,NEW.account_id,
      NEW.erasure_human_id,NEW.erasure_operator_id,NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id,
      NEW.created_at,NEW.expires_at,NEW.sink_generation,NEW.custody,NEW.erasure_role_version,NEW.erasure_role_xid)
    IS DISTINCT FROM ROW(OLD.delivery_id,OLD.producer,OLD.source_component,OLD.account_id,
      OLD.erasure_human_id,OLD.erasure_operator_id,OLD.erasure_client_owner_id,OLD.erasure_source_client_owner_id,
      OLD.created_at,OLD.expires_at,OLD.sink_generation,OLD.custody,OLD.erasure_role_version,OLD.erasure_role_xid) THEN
    RAISE EXCEPTION 'Auth recovery Source is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='intent' AND NEW.status='in-flight' AND OLD.attempts=0 AND NEW.attempts=1
    AND OLD.attempted_at IS NULL AND NEW.attempted_at IS NOT NULL
    AND NEW.code='receiving-result-unavailable' THEN
    FOREACH owner_id IN ARRAY ARRAY[NEW.account_id,NEW.erasure_human_id,NEW.erasure_operator_id,
        NEW.erasure_client_owner_id,NEW.erasure_source_client_owner_id] LOOP
      PERFORM auth_erasure_admit(owner_id);
      IF EXISTS(SELECT 1 FROM auth_erasure WHERE account_id=owner_id) THEN
        RAISE EXCEPTION 'Auth erasure fence' USING ERRCODE='55000';
      END IF;
    END LOOP;
  ELSIF OLD.status='in-flight' AND NEW.status='unknown' AND NEW.attempts=OLD.attempts
    AND NEW.attempted_at=OLD.attempted_at
    AND NEW.code IN ('legacy-void','unsupported-result','callback-failed','callback-timeout') THEN
    -- Late completion is technical evidence only; current erasure does not
    -- authorize resending, invalidate the source, or certify a receiver fence.
    NULL;
  ELSE
    RAISE EXCEPTION 'Auth recovery Source progress refused' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_request_parties_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_request_parties_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: auth_require_cursor_cutover(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_require_cursor_cutover() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF current_setting('auth.cursor_backfill',true) IS DISTINCT FROM '2' AND NOT EXISTS
     (SELECT 1 FROM auth_erasure_cursor_cutover WHERE singleton AND completed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Auth cursor cutover incomplete; quiesce writers and resume deployment';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME IN ('user','auth_consent') THEN
    IF TG_OP = 'INSERT' THEN NEW.traversal_ordinal := nextval('auth_traversal_ordinal'); END IF;
    IF NEW.traversal_ordinal IS NULL THEN RAISE EXCEPTION 'Auth ordinal required'; END IF;
  ELSE
    IF NEW.legacy_after_account IS NOT NULL THEN RAISE EXCEPTION 'Auth cursor worker version refused'; END IF;
    IF TG_TABLE_NAME = 'auth_client_reduction_progress' THEN
      IF TG_OP = 'UPDATE' AND NEW.completed IS DISTINCT FROM OLD.completed
         AND current_setting('auth.cursor_worker',true) IS DISTINCT FROM '2'
         AND current_setting('auth.cursor_backfill',true) IS DISTINCT FROM '2' THEN
        RAISE EXCEPTION 'Auth cursor worker version refused';
      END IF;
      IF NEW.legacy_page_after IS NOT NULL OR NEW.legacy_terminal_account IS NOT NULL THEN
        RAISE EXCEPTION 'Auth cursor worker version refused';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_restore_cut_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_restore_cut_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.source_cut_id IS DISTINCT FROM OLD.source_cut_id
    OR NEW.source_verify_partition < OLD.source_verify_partition
    OR NEW.source_revision < OLD.source_revision THEN
    RAISE EXCEPTION 'Auth native Source cut locator is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_restore_identity_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_restore_identity_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.generation IS DISTINCT FROM OLD.generation
    OR (OLD.inventory IS NOT NULL AND NEW.inventory IS DISTINCT FROM OLD.inventory)
    OR (OLD.native_coverage_started AND NOT NEW.native_coverage_started) THEN
    RAISE EXCEPTION 'Auth restore identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_restore_live_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_restore_live_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.generation IS DISTINCT FROM OLD.generation THEN
    RAISE EXCEPTION 'Auth live receiver is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='auth_restore_live_generation' THEN
    IF NEW.inventory IS DISTINCT FROM OLD.inventory OR NEW.source_cut_id IS DISTINCT FROM OLD.source_cut_id
      OR NEW.replay_inventory_after<OLD.replay_inventory_after
      OR (OLD.replay_inventory_complete AND NOT NEW.replay_inventory_complete) THEN
      RAISE EXCEPTION 'Auth live inventory binding is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='auth_restore_live_partition' THEN
    IF NEW.partition IS DISTINCT FROM OLD.partition OR NEW.arm IS DISTINCT FROM OLD.arm
      OR NEW.after_ordinal<OLD.after_ordinal OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'Auth live Source checkpoint is immutable' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.obligation_id IS DISTINCT FROM OLD.obligation_id
    OR (OLD.state='external' AND NEW.state<>'external') THEN
    RAISE EXCEPTION 'Auth live native work identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_restore_obligation_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_restore_obligation_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.source_obligation IS NOT NULL AND NEW.source_obligation IS DISTINCT FROM OLD.source_obligation THEN
    RAISE EXCEPTION 'Auth original Source obligation is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_restore_replay_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_restore_replay_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' OR NEW.generation IS DISTINCT FROM OLD.generation
    OR NEW.obligation_id IS DISTINCT FROM OLD.obligation_id OR NEW.original_progress IS DISTINCT FROM OLD.original_progress
    OR (OLD.user_replayed AND NOT NEW.user_replayed)
    OR (OLD.native_completed_at IS NOT NULL AND NEW.native_completed_at IS DISTINCT FROM OLD.native_completed_at)
    OR (OLD.consent_completed_at IS NOT NULL AND NEW.consent_completed_at IS DISTINCT FROM OLD.consent_completed_at)
    OR (OLD.copies_completed_at IS NOT NULL AND NEW.copies_completed_at IS DISTINCT FROM OLD.copies_completed_at) THEN
    RAISE EXCEPTION 'Auth restore replay evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_restore_source_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_restore_source_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (OLD.source_route IS NOT NULL AND NEW.source_route IS DISTINCT FROM OLD.source_route)
    OR (OLD.original_native_id IS NOT NULL AND NEW.original_native_id IS DISTINCT FROM OLD.original_native_id)
    OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
    OR (OLD.user_deleted_at IS NOT NULL AND NEW.user_deleted_at IS DISTINCT FROM OLD.user_deleted_at)
    OR (OLD.consent_due_at IS NOT NULL AND NEW.consent_due_at IS DISTINCT FROM OLD.consent_due_at)
    OR (OLD.consent_completed_at IS NOT NULL AND NEW.consent_completed_at IS DISTINCT FROM OLD.consent_completed_at)
    OR (OLD.applicable AND NOT NEW.applicable) THEN
    RAISE EXCEPTION 'Auth restored source evidence is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_revoke_sessions(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_revoke_sessions(owner_id text) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE affected integer;
BEGIN
  PERFORM auth_assert_session_capacity(owner_id, true);
  DELETE FROM session WHERE "userId"=owner_id;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END $$;


--
-- Name: auth_session_erasure_barrier(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_session_erasure_barrier() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT OLD.sessions_bounded THEN
    RAISE EXCEPTION 'Session history upgrade required' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;


--
-- Name: auth_session_identity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_session_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.id, NEW."userId") IS DISTINCT FROM (OLD.id, OLD."userId") THEN
    RAISE EXCEPTION 'Session identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_session_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_session_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE keys text[];
BEGIN
  -- Runs inside the native INSERT's connection and transaction. The owner row
  -- lock survives through the INSERT and its native FK checks/commit/rollback.
  PERFORM auth_assert_session_capacity(NEW."userId", true);
  -- Do not let eviction erase a conflicting key and turn an invalid native
  -- INSERT into replacement of an existing session.
  IF EXISTS (SELECT 1 FROM session WHERE id=NEW.id) OR
     EXISTS (SELECT 1 FROM session WHERE token=NEW.token) THEN
    RAISE EXCEPTION 'Duplicate session key' USING ERRCODE='23505';
  END IF;
  SELECT array_agg(id ORDER BY "createdAt", id) INTO keys FROM (
    SELECT id, "createdAt" FROM session WHERE "userId"=NEW."userId"
    ORDER BY "createdAt", id LIMIT 64
  ) bounded;
  IF cardinality(keys)=64 THEN
    DELETE FROM session WHERE id=keys[1];
  END IF;
  RETURN NEW;
END $$;


--
-- Name: auth_trim_session_history(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auth_trim_session_history(owner_id text, batch integer) RETURNS TABLE(deleted integer, ready boolean)
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF batch IS NULL OR batch < 1 OR batch > 1000 THEN
    RAISE EXCEPTION 'Invalid session trimming batch' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM "user" WHERE id=owner_id FOR UPDATE;
  -- Keep the newest 64, reading/deleting only one admitted page beyond them.
  DELETE FROM session WHERE id=ANY(ARRAY(
    SELECT id FROM session WHERE "userId"=owner_id
    ORDER BY "createdAt" DESC, id DESC OFFSET 64 LIMIT batch
  ));
  GET DIAGNOSTICS deleted = ROW_COUNT;
  ready := NOT EXISTS (
    SELECT 1 FROM session WHERE "userId"=owner_id
    ORDER BY "createdAt" DESC, id DESC OFFSET 64 LIMIT 1
  );
  IF ready THEN UPDATE "user" SET sessions_bounded=true WHERE id=owner_id; END IF;
  RETURN NEXT;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    CONSTRAINT account_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT password_owner CHECK ((("providerId" = 'credential'::text) AND ("accountId" = "userId")))
);


--
-- Name: auth_attempt_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_attempt_account (
    account_id text NOT NULL,
    key text NOT NULL,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    CONSTRAINT auth_attempt_account_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1])))
);


--
-- Name: auth_attempt_counter; Type: TABLE; Schema: public; Owner: -
--

CREATE UNLOGGED TABLE public.auth_attempt_counter (
    key text NOT NULL,
    count integer NOT NULL,
    last_request timestamp with time zone NOT NULL,
    accepted boolean NOT NULL,
    CONSTRAINT auth_attempt_counter_count_check CHECK ((count > 0)),
    CONSTRAINT auth_attempt_counter_key_check CHECK ((key ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: auth_barrier_proof; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_barrier_proof (
    reference text NOT NULL,
    account_id text NOT NULL,
    purpose text NOT NULL,
    previous_epoch integer NOT NULL,
    operation_key text NOT NULL,
    digest text NOT NULL,
    evidence jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    applied_at timestamp with time zone,
    erasure_source_client_id text,
    erasure_client_id text,
    erasure_session_id text,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_barrier_proof_account_id_check CHECK (((length(account_id) >= 1) AND (length(account_id) <= 1024))),
    CONSTRAINT auth_barrier_proof_check CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:05:00'::interval)))),
    CONSTRAINT auth_barrier_proof_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT auth_barrier_proof_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_barrier_proof_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_barrier_proof_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024)),
    CONSTRAINT auth_barrier_proof_evidence_check CHECK (((jsonb_typeof(evidence) = 'array'::text) AND (octet_length((evidence)::text) <= 65536))),
    CONSTRAINT auth_barrier_proof_operation_key_check CHECK (((length(operation_key) >= 1) AND (length(operation_key) <= 128))),
    CONSTRAINT auth_barrier_proof_previous_epoch_check CHECK ((previous_epoch >= 0)),
    CONSTRAINT auth_barrier_proof_purpose_check CHECK ((purpose = ANY (ARRAY['consent-reduction'::text, 'recovery'::text]))),
    CONSTRAINT auth_barrier_proof_reference_check CHECK ((reference ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: auth_client; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client (
    client_id text NOT NULL,
    first_party boolean NOT NULL,
    scopes text[] NOT NULL,
    id text GENERATED ALWAYS AS (client_id) STORED,
    "clientSecret" text,
    "clientDiscoveryId" text,
    disabled boolean DEFAULT false,
    "enableEndSession" boolean,
    "subjectType" text,
    "sectorIdentifier" text,
    "clientCredentialsScopes" jsonb,
    "userId" text,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    name text,
    uri text,
    icon text,
    contacts jsonb,
    tos text,
    policy text,
    "softwareId" text,
    "softwareVersion" text,
    "softwareStatement" text,
    "redirectUris" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "postLogoutRedirectUris" jsonb,
    "backchannelLogoutUri" text,
    "backchannelLogoutSessionRequired" boolean,
    "frontchannelLogoutUri" text,
    "frontchannelLogoutSessionRequired" boolean,
    "tokenEndpointAuthMethod" text,
    "applicationType" text,
    jwks text,
    "jwksUri" text,
    "grantTypes" jsonb,
    "responseTypes" jsonb,
    "requirePKCE" boolean,
    "dpopBoundAccessTokens" boolean DEFAULT false,
    "referenceId" text,
    metadata jsonb,
    display_name text,
    erasure_fenced boolean DEFAULT false NOT NULL,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    display_name_writer integer,
    CONSTRAINT auth_client_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1])))
);


--
-- Name: auth_client_coverage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client_coverage (
    client_id text NOT NULL,
    legacy_after_account text,
    ready boolean DEFAULT false NOT NULL,
    ready_after timestamp with time zone DEFAULT (CURRENT_TIMESTAMP + '00:05:00'::interval) NOT NULL,
    after_ordinal bigint DEFAULT 0 NOT NULL,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_client_coverage_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_client_coverage_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_client_coverage_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: auth_client_reduction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client_reduction (
    client_id text NOT NULL,
    operation_id text NOT NULL,
    scopes text[] NOT NULL,
    first_party boolean NOT NULL,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_client_reduction_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_client_reduction_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_client_reduction_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: auth_client_reduction_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client_reduction_progress (
    operation_id text NOT NULL,
    client_id text NOT NULL,
    scopes text[] NOT NULL,
    first_party boolean NOT NULL,
    legacy_after_account text,
    legacy_page_after text,
    legacy_terminal_account text,
    completed boolean DEFAULT false NOT NULL,
    after_ordinal bigint DEFAULT 0 NOT NULL,
    page_after bigint DEFAULT 0 NOT NULL,
    page_end bigint DEFAULT 0 NOT NULL,
    terminal_ordinal bigint,
    cutover_after bigint,
    consumer_version smallint DEFAULT 0 NOT NULL,
    page_count integer,
    completed_count integer DEFAULT 0 NOT NULL,
    current_workflow_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_client_reduction_progre_erasure_source_client_owner__check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024)),
    CONSTRAINT auth_client_reduction_progress_current_workflow_id_check CHECK ((octet_length(current_workflow_id) <= 256)),
    CONSTRAINT auth_client_reduction_progress_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_client_reduction_progress_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1])))
);


--
-- Name: auth_consent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_consent (
    account_id text NOT NULL,
    client_id text NOT NULL,
    scopes text[] NOT NULL,
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    "referenceId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    pending_scopes text[],
    pending_reference text,
    traversal_ordinal bigint,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_consent_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_consent_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_consent_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024)),
    CONSTRAINT auth_consent_pending_pair CHECK (((pending_scopes IS NULL) = (pending_reference IS NULL))),
    CONSTRAINT auth_consent_revision_check CHECK ((revision > 0))
);


--
-- Name: auth_consent_erasure; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_consent_erasure (
    account_id text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    after_client text DEFAULT ''::text NOT NULL
);


--
-- Name: auth_copy_artifact; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_copy_artifact (
    workflow_id text NOT NULL,
    kind text NOT NULL,
    key text NOT NULL,
    bytes integer NOT NULL,
    CONSTRAINT auth_copy_artifact_bytes_check CHECK (((bytes >= 0) AND (bytes <= 65536))),
    CONSTRAINT auth_copy_artifact_key_check CHECK ((octet_length(key) <= 384)),
    CONSTRAINT auth_copy_artifact_kind_check CHECK ((kind = ANY (ARRAY['workflow_status'::text, 'workflow_input'::text, 'workflow_output'::text, 'operation_outputs'::text, 'workflow_events'::text, 'workflow_events_history'::text, 'notifications'::text])))
);


--
-- Name: auth_copy_coverage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_copy_coverage (
    singleton boolean DEFAULT true NOT NULL,
    version integer NOT NULL,
    covered boolean DEFAULT false NOT NULL,
    native_covered boolean DEFAULT false NOT NULL,
    CONSTRAINT auth_copy_coverage_singleton_check CHECK (singleton),
    CONSTRAINT auth_copy_coverage_version_check CHECK ((version = 1))
);


--
-- Name: auth_copy_role; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_copy_role (
    account_id text NOT NULL,
    workflow_id text NOT NULL,
    role text NOT NULL,
    CONSTRAINT auth_copy_role_account_id_check CHECK ((octet_length(account_id) <= 128)),
    CONSTRAINT auth_copy_role_role_check CHECK ((role = ANY (ARRAY['subject'::text, 'human'::text, 'operator'::text, 'member'::text, 'previous-operator'::text, 'initiator'::text, 'delegate'::text, 'client-owner'::text])))
);


--
-- Name: auth_copy_work; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_copy_work (
    workflow_id text NOT NULL,
    name text NOT NULL,
    digest bytea NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    scope_count integer NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    retired boolean DEFAULT false NOT NULL,
    absent boolean DEFAULT false NOT NULL,
    rows integer DEFAULT 0 NOT NULL,
    bytes integer DEFAULT 0 NOT NULL,
    parent_workflow_id text,
    source_key text,
    result_digest bytea,
    result_finished_at timestamp with time zone,
    sdk_fence_generation text,
    sdk_fence_closure_id uuid,
    sdk_fence_closed_at bigint,
    sdk_fence_pending text,
    CONSTRAINT auth_copy_native_fence CHECK ((((sdk_fence_generation IS NULL) AND (sdk_fence_closure_id IS NULL) AND (sdk_fence_closed_at IS NULL)) OR ((sdk_fence_generation IS NOT NULL) AND (sdk_fence_generation = '2'::text) AND (sdk_fence_closure_id IS NOT NULL) AND (sdk_fence_closed_at IS NOT NULL) AND ((sdk_fence_closed_at >= 1) AND (sdk_fence_closed_at <= '9007199254740991'::bigint)) AND ready AND (result_finished_at IS NOT NULL)))),
    CONSTRAINT auth_copy_result_source CHECK (((result_digest IS NULL) = (result_finished_at IS NULL))),
    CONSTRAINT auth_copy_work_bytes_check CHECK (((bytes >= 0) AND (bytes <= 10485760))),
    CONSTRAINT auth_copy_work_check CHECK (((NOT absent) OR retired)),
    CONSTRAINT auth_copy_work_digest_check CHECK ((octet_length(digest) = 32)),
    CONSTRAINT auth_copy_work_name_check CHECK ((name = ANY (ARRAY['accounts.registration'::text, 'accounts.operation'::text, 'accounts.client-reduction'::text]))),
    CONSTRAINT auth_copy_work_result_digest_check CHECK ((octet_length(result_digest) = 32)),
    CONSTRAINT auth_copy_work_rows_check CHECK (((rows >= 0) AND (rows <= 139))),
    CONSTRAINT auth_copy_work_scope_count_check CHECK (((scope_count >= 1) AND (scope_count <= 16))),
    CONSTRAINT auth_copy_work_sdk_fence_pending_check CHECK ((sdk_fence_pending = ANY (ARRAY['auth-sdk-permanent-late-writer-fence-unavailable'::text, 'auth-sdk-native-fence-receipt-mismatch'::text, 'auth-sdk-original-result-pending'::text, 'auth-sdk-original-copy-mapping-unavailable'::text, 'auth-sdk-original-source-pending'::text, 'auth-sdk-original-consumer-pending'::text, 'auth-sdk-native-copy-coverage-pending'::text, 'auth-sdk-physical-copies-pending'::text]))),
    CONSTRAINT auth_copy_work_source_key_check CHECK ((octet_length(source_key) <= 256)),
    CONSTRAINT auth_copy_work_version_check CHECK ((version = 1)),
    CONSTRAINT auth_copy_work_workflow_id_check CHECK ((octet_length(workflow_id) <= 256))
);


--
-- Name: auth_effect_receipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_effect_receipt (
    receipt_id text NOT NULL,
    account_id text NOT NULL,
    purpose text NOT NULL,
    minimum_authn_epoch integer NOT NULL,
    operation_key text,
    effect_reference text,
    effect_digest text,
    stage_version integer,
    credential_row_id text,
    credential_row_version text,
    acting_human_id text,
    client_id text,
    scopes text[],
    stage_ciphertext bytea,
    opening_receipt_id text,
    committed_result jsonb,
    committed_at timestamp with time zone,
    opening_reference text,
    erasure_operator_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_credential_stage CHECK (((((operation_key IS NULL) AND (effect_reference IS NULL) AND (effect_digest IS NULL) AND (stage_version IS NULL) AND (stage_ciphertext IS NULL) AND (committed_result IS NULL) AND (committed_at IS NULL) AND (opening_receipt_id IS NULL)) OR ((operation_key IS NOT NULL) AND (effect_reference IS NOT NULL) AND (effect_digest ~ '^[a-f0-9]{64}$'::text) AND (stage_version = 1) AND (stage_ciphertext IS NOT NULL) AND (acting_human_id IS NOT NULL) AND (client_id IS NOT NULL) AND (scopes IS NOT NULL) AND (purpose = ANY (ARRAY['set-password'::text, 'remove-password'::text, 'add-key'::text, 'remove-key'::text, 'add-passkey'::text, 'remove-passkey'::text])) AND ((credential_row_id IS NULL) = (credential_row_version IS NULL)) AND (((committed_at IS NULL) AND (committed_result IS NULL) AND (opening_receipt_id IS NULL)) OR ((committed_at IS NOT NULL) AND (opening_receipt_id IS NOT NULL) AND (committed_result = jsonb_build_object('receiptId', receipt_id, 'replayed', false)))))) IS TRUE)),
    CONSTRAINT auth_effect_receipt_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_effect_receipt_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_effect_receipt_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024)),
    CONSTRAINT auth_effect_receipt_minimum_authn_epoch_check CHECK ((minimum_authn_epoch >= 0))
);


--
-- Name: auth_erased_client; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_erased_client (
    client_id text NOT NULL,
    obligation_id bigint NOT NULL
);


--
-- Name: auth_erasure; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_erasure (
    id bigint NOT NULL,
    account_id text NOT NULL,
    barrier integer NOT NULL,
    version integer NOT NULL,
    applicable boolean DEFAULT false NOT NULL,
    inventory_coverage text DEFAULT 'unknown'::text NOT NULL,
    inventory_completed_at timestamp with time zone,
    phase integer DEFAULT 0 NOT NULL,
    after_key text DEFAULT ''::text NOT NULL,
    client_id text,
    client_phase integer DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    accepted_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    user_deleted_at timestamp with time zone,
    native_completed_at timestamp with time zone,
    consent_due_at timestamp with time zone,
    consent_completed_at timestamp with time zone,
    pending_code text DEFAULT 'native'::text NOT NULL,
    kernel_version integer,
    kernel_at text,
    source_continuation_id uuid,
    source_receipt_id uuid,
    source_workflow_id text,
    source_accepted_at timestamp with time zone,
    source_discharged_at timestamp with time zone,
    source_published_at timestamp with time zone,
    copies_completed_at timestamp with time zone,
    copies_published_at timestamp with time zone,
    native_role_version smallint DEFAULT 0 NOT NULL,
    native_phase_version smallint DEFAULT 3 NOT NULL,
    native_phase_upgrade jsonb,
    source_route integer,
    original_native_id text,
    recovery_copy_pending text DEFAULT 'recovery-copy-coverage'::text NOT NULL,
    CONSTRAINT auth_erasure_after_key_check CHECK ((octet_length(after_key) <= 1024)),
    CONSTRAINT auth_erasure_barrier_check CHECK ((barrier >= 0)),
    CONSTRAINT auth_erasure_client_id_check CHECK ((octet_length(client_id) <= 1024)),
    CONSTRAINT auth_erasure_inventory_coverage_check CHECK ((inventory_coverage = ANY (ARRAY['unknown'::text, 'covered'::text]))),
    CONSTRAINT auth_erasure_kernel_at_check CHECK ((octet_length(kernel_at) <= 64)),
    CONSTRAINT auth_erasure_kernel_identity CHECK ((((kernel_version IS NULL) AND (kernel_at IS NULL)) OR ((kernel_version > 0) AND (kernel_at IS NOT NULL)))),
    CONSTRAINT auth_erasure_native_phase_upgrade_check CHECK ((octet_length((native_phase_upgrade)::text) <= 16384)),
    CONSTRAINT auth_erasure_native_phase_version_check CHECK ((native_phase_version = ANY (ARRAY[1, 2, 3]))),
    CONSTRAINT auth_erasure_native_role_version_check CHECK ((native_role_version = ANY (ARRAY[0, 1]))),
    CONSTRAINT auth_erasure_original_native_id_check CHECK (((octet_length(original_native_id) >= 1) AND (octet_length(original_native_id) <= 1024))),
    CONSTRAINT auth_erasure_recovery_copy_pending_check CHECK ((recovery_copy_pending = ANY (ARRAY['recovery-copy-custody'::text, 'recovery-copy-coverage'::text]))),
    CONSTRAINT auth_erasure_source CHECK ((((source_continuation_id IS NULL) AND (source_receipt_id IS NULL) AND (source_accepted_at IS NULL) AND (source_discharged_at IS NULL) AND (source_published_at IS NULL)) OR ((kernel_at IS NOT NULL) AND (source_continuation_id IS NOT NULL) AND (source_receipt_id IS NOT NULL) AND (source_accepted_at IS NOT NULL) AND ((source_published_at IS NULL) OR (source_discharged_at IS NOT NULL))))),
    CONSTRAINT auth_erasure_source_route_check CHECK (((source_route >= 0) AND (source_route <= 65535))),
    CONSTRAINT auth_erasure_source_workflow_id_check CHECK ((octet_length(source_workflow_id) <= 256)),
    CONSTRAINT auth_erasure_version_check CHECK ((version = 1))
);


--
-- Name: auth_erasure_cursor_cutover; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_erasure_cursor_cutover (
    singleton boolean DEFAULT true NOT NULL,
    writer_version integer DEFAULT 2 NOT NULL,
    phase text NOT NULL,
    after_key text,
    after_client text,
    completed_at timestamp with time zone,
    CONSTRAINT auth_erasure_cursor_cutover_phase_check CHECK ((phase = ANY (ARRAY['users'::text, 'consents'::text, 'coverage'::text, 'reduction'::text, 'done'::text]))),
    CONSTRAINT auth_erasure_cursor_cutover_singleton_check CHECK (singleton),
    CONSTRAINT auth_erasure_cursor_cutover_writer_version_check CHECK ((writer_version = 2))
);


--
-- Name: auth_erasure_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.auth_erasure ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.auth_erasure_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: auth_key_assertion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_key_assertion (
    account_id text NOT NULL,
    jti text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    CONSTRAINT auth_key_assertion_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1])))
);


--
-- Name: auth_kind_consent_dependency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_kind_consent_dependency (
    enrollment_seq bigint NOT NULL,
    reference_id uuid DEFAULT gen_random_uuid() NOT NULL,
    consumer_key_hash bytea NOT NULL,
    account_id text NOT NULL,
    client_id text NOT NULL,
    requested_scopes text[] NOT NULL,
    effective_scopes text[] NOT NULL,
    consent_revision bigint NOT NULL,
    client_scopes text[] NOT NULL,
    client_first_party boolean NOT NULL,
    consumer_route text NOT NULL,
    owner_account_id text NOT NULL,
    collection_id text NOT NULL,
    preparation_id text NOT NULL,
    origin_id text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    fenced_transition_id uuid,
    receipt_reference text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    fenced_at timestamp with time zone,
    CONSTRAINT auth_kind_consent_dependency_account_id_check CHECK (((octet_length(account_id) >= 1) AND (octet_length(account_id) <= 1024))),
    CONSTRAINT auth_kind_consent_dependency_check CHECK (((fenced_transition_id IS NULL) = (receipt_reference IS NULL))),
    CONSTRAINT auth_kind_consent_dependency_check1 CHECK ((active OR ((fenced_transition_id IS NOT NULL) AND (fenced_at IS NOT NULL)))),
    CONSTRAINT auth_kind_consent_dependency_client_id_check CHECK (((octet_length(client_id) >= 1) AND (octet_length(client_id) <= 1024))),
    CONSTRAINT auth_kind_consent_dependency_client_scopes_check CHECK ((cardinality(client_scopes) <= 512)),
    CONSTRAINT auth_kind_consent_dependency_collection_id_check CHECK (((octet_length(collection_id) >= 1) AND (octet_length(collection_id) <= 1024))),
    CONSTRAINT auth_kind_consent_dependency_consent_revision_check CHECK ((consent_revision >= 0)),
    CONSTRAINT auth_kind_consent_dependency_consumer_key_hash_check CHECK ((octet_length(consumer_key_hash) = 32)),
    CONSTRAINT auth_kind_consent_dependency_consumer_route_check CHECK (((octet_length(consumer_route) >= 1) AND (octet_length(consumer_route) <= 1024))),
    CONSTRAINT auth_kind_consent_dependency_effective_scopes_check CHECK ((cardinality(effective_scopes) <= 512)),
    CONSTRAINT auth_kind_consent_dependency_origin_id_check CHECK (((octet_length(origin_id) >= 1) AND (octet_length(origin_id) <= 1024))),
    CONSTRAINT auth_kind_consent_dependency_owner_account_id_check CHECK (((octet_length(owner_account_id) >= 1) AND (octet_length(owner_account_id) <= 1024))),
    CONSTRAINT auth_kind_consent_dependency_preparation_id_check CHECK (((octet_length(preparation_id) >= 1) AND (octet_length(preparation_id) <= 1024))),
    CONSTRAINT auth_kind_consent_dependency_receipt_reference_check CHECK (((receipt_reference IS NULL) OR (octet_length(receipt_reference) <= 1024))),
    CONSTRAINT auth_kind_consent_dependency_requested_scopes_check CHECK ((cardinality(requested_scopes) <= 512))
);


--
-- Name: auth_kind_consent_dependency_enrollment_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_kind_consent_dependency_enrollment_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_kind_consent_dependency_enrollment_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.auth_kind_consent_dependency_enrollment_seq_seq OWNED BY public.auth_kind_consent_dependency.enrollment_seq;


--
-- Name: auth_kind_consent_transition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_kind_consent_transition (
    transition_id uuid DEFAULT gen_random_uuid() NOT NULL,
    transition_key text NOT NULL,
    transition_kind text NOT NULL,
    client_id text NOT NULL,
    account_id text,
    target jsonb NOT NULL,
    frontier_seq bigint NOT NULL,
    after_seq bigint DEFAULT 0 NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    applied_at timestamp with time zone,
    CONSTRAINT auth_kind_consent_transition_account_id_check CHECK (((account_id IS NULL) OR ((octet_length(account_id) >= 1) AND (octet_length(account_id) <= 1024)))),
    CONSTRAINT auth_kind_consent_transition_check CHECK (((after_seq >= 0) AND (after_seq <= frontier_seq))),
    CONSTRAINT auth_kind_consent_transition_check1 CHECK (((transition_kind = 'consent'::text) = (account_id IS NOT NULL))),
    CONSTRAINT auth_kind_consent_transition_check2 CHECK (((transition_kind = 'restore'::text) = ((client_id = '*'::text) AND (account_id IS NULL)))),
    CONSTRAINT auth_kind_consent_transition_check3 CHECK (((state = 'applied'::text) = (applied_at IS NOT NULL))),
    CONSTRAINT auth_kind_consent_transition_client_id_check CHECK (((octet_length(client_id) >= 1) AND (octet_length(client_id) <= 1024))),
    CONSTRAINT auth_kind_consent_transition_frontier_seq_check CHECK ((frontier_seq >= 0)),
    CONSTRAINT auth_kind_consent_transition_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text, 'applied'::text]))),
    CONSTRAINT auth_kind_consent_transition_target_check CHECK (((jsonb_typeof(target) = 'object'::text) AND (octet_length((target)::text) <= 8192))),
    CONSTRAINT auth_kind_consent_transition_transition_key_check CHECK (((octet_length(transition_key) >= 1) AND (octet_length(transition_key) <= 1024))),
    CONSTRAINT auth_kind_consent_transition_transition_kind_check CHECK ((transition_kind = ANY (ARRAY['consent'::text, 'client'::text, 'restore'::text])))
);


--
-- Name: auth_metadata_scrub; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_metadata_scrub (
    store text NOT NULL,
    writer_version integer NOT NULL,
    after_key text,
    CONSTRAINT auth_metadata_scrub_after_key_check CHECK ((octet_length(after_key) <= 1024)),
    CONSTRAINT auth_metadata_scrub_store_check CHECK ((store = ANY (ARRAY['auth_client'::text, 'oauthResource'::text, 'oauthClientResource'::text]))),
    CONSTRAINT auth_metadata_scrub_writer_version_check CHECK ((writer_version = 1))
);


--
-- Name: auth_native_consumer_proof; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_native_consumer_proof (
    store text NOT NULL,
    key text NOT NULL,
    binding jsonb NOT NULL,
    result jsonb NOT NULL,
    CONSTRAINT auth_native_consumer_proof_key_check CHECK ((octet_length(key) <= 1024))
);


--
-- Name: auth_native_credential_terminal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_native_credential_terminal (
    receipt_id text NOT NULL,
    obligation_id bigint NOT NULL,
    operation_key text NOT NULL,
    effect_reference text NOT NULL,
    effect_digest text NOT NULL,
    account_id text NOT NULL,
    minimum_authn_epoch integer NOT NULL,
    opening_receipt_id text,
    outcome text NOT NULL,
    committed_result jsonb,
    CONSTRAINT auth_native_credential_terminal_effect_digest_check CHECK ((effect_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT auth_native_credential_terminal_outcome_check CHECK ((outcome = ANY (ARRAY['committed'::text, 'fenced-refusal'::text]))),
    CONSTRAINT auth_native_credential_terminal_receipt_id_check CHECK ((octet_length(receipt_id) <= 1024))
);


--
-- Name: auth_native_phase_deployment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_native_phase_deployment (
    singleton boolean DEFAULT true NOT NULL,
    version smallint NOT NULL,
    CONSTRAINT auth_native_phase_deployment_singleton_check CHECK (singleton),
    CONSTRAINT auth_native_phase_deployment_version_check CHECK ((version = 3))
);


--
-- Name: auth_native_role_deployment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_native_role_deployment (
    singleton boolean DEFAULT true NOT NULL,
    version smallint NOT NULL,
    armed boolean DEFAULT false NOT NULL,
    store_index smallint DEFAULT 0 NOT NULL,
    CONSTRAINT auth_native_role_deployment_singleton_check CHECK (singleton),
    CONSTRAINT auth_native_role_deployment_store_index_check CHECK (((store_index >= 0) AND (store_index <= 28))),
    CONSTRAINT auth_native_role_deployment_version_check CHECK ((version = 1))
);


--
-- Name: auth_native_role_unknown; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_native_role_unknown (
    store text NOT NULL,
    reason text NOT NULL,
    CONSTRAINT auth_native_role_unknown_reason_check CHECK ((reason = ANY (ARRAY['historical-role-custody'::text, 'unsupported-producer-format'::text, 'source-unavailable'::text])))
);


--
-- Name: auth_provisioning_receipt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_provisioning_receipt (
    idempotency_key text NOT NULL,
    account_id text NOT NULL,
    digest bytea NOT NULL,
    registration_id text,
    reservation_id text,
    authn_epoch bigint,
    expires_at timestamp with time zone,
    owner_id text,
    credential_id text,
    provisioning_kind text,
    erasure_creator_id text,
    erasure_operator_id text,
    erasure_stage_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_delegate_id text,
    erasure_initiator_id text,
    erasure_actor_version smallint DEFAULT 0 NOT NULL,
    creation_context_version smallint DEFAULT 0 NOT NULL,
    creation_scope_digest bytea,
    creation_context jsonb,
    creation_approval_reference text,
    erasure_actor_id text,
    erasure_human_id text,
    erasure_principal_id text,
    erasure_native_operator_id text,
    erasure_client_id text,
    erasure_source_client_id text,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_provisioning_evidence_complete CHECK ((((registration_id IS NULL) AND (reservation_id IS NULL) AND (authn_epoch IS NULL) AND (expires_at IS NULL) AND (owner_id IS NULL) AND (credential_id IS NULL) AND (provisioning_kind IS NULL)) OR ((registration_id IS NOT NULL) AND (reservation_id IS NOT NULL) AND (authn_epoch IS NOT NULL) AND ((authn_epoch >= 1) AND (authn_epoch <= '9007199254740991'::bigint)) AND (expires_at IS NOT NULL) AND (owner_id IS NOT NULL) AND (owner_id = account_id) AND (credential_id IS NOT NULL) AND (provisioning_kind IS NOT NULL) AND (provisioning_kind = ANY (ARRAY['password'::text, 'credentialless'::text]))))),
    CONSTRAINT auth_provisioning_receipt_creation_approval_reference_check CHECK (((octet_length(creation_approval_reference) >= 1) AND (octet_length(creation_approval_reference) <= 4096))),
    CONSTRAINT auth_provisioning_receipt_creation_context_version_check CHECK ((creation_context_version = ANY (ARRAY[0, 1]))),
    CONSTRAINT auth_provisioning_receipt_creation_scope_digest_check CHECK ((octet_length(creation_scope_digest) = 32)),
    CONSTRAINT auth_provisioning_receipt_erasure_actor_id_check CHECK (((octet_length(erasure_actor_id) >= 1) AND (octet_length(erasure_actor_id) <= 1024))),
    CONSTRAINT auth_provisioning_receipt_erasure_actor_version_check CHECK ((erasure_actor_version = ANY (ARRAY[0, 1]))),
    CONSTRAINT auth_provisioning_receipt_erasure_client_id_check CHECK (((octet_length(erasure_client_id) >= 1) AND (octet_length(erasure_client_id) <= 1024))),
    CONSTRAINT auth_provisioning_receipt_erasure_client_owner_id_check CHECK (((octet_length(erasure_client_owner_id) >= 1) AND (octet_length(erasure_client_owner_id) <= 1024))),
    CONSTRAINT auth_provisioning_receipt_erasure_delegate_id_check CHECK ((octet_length(erasure_delegate_id) <= 1024)),
    CONSTRAINT auth_provisioning_receipt_erasure_human_id_check CHECK (((octet_length(erasure_human_id) >= 1) AND (octet_length(erasure_human_id) <= 1024))),
    CONSTRAINT auth_provisioning_receipt_erasure_initiator_id_check CHECK ((octet_length(erasure_initiator_id) <= 1024)),
    CONSTRAINT auth_provisioning_receipt_erasure_native_operator_id_check CHECK (((octet_length(erasure_native_operator_id) >= 1) AND (octet_length(erasure_native_operator_id) <= 1024))),
    CONSTRAINT auth_provisioning_receipt_erasure_principal_id_check CHECK (((octet_length(erasure_principal_id) >= 1) AND (octet_length(erasure_principal_id) <= 1024))),
    CONSTRAINT auth_provisioning_receipt_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_provisioning_receipt_erasure_source_client_id_check CHECK (((octet_length(erasure_source_client_id) >= 1) AND (octet_length(erasure_source_client_id) <= 1024))),
    CONSTRAINT auth_provisioning_receipt_erasure_source_client_owner_id_check CHECK (((octet_length(erasure_source_client_owner_id) >= 1) AND (octet_length(erasure_source_client_owner_id) <= 1024)))
);


--
-- Name: auth_public_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_public_key (
    account_id text NOT NULL,
    kid text NOT NULL,
    public_jwk jsonb NOT NULL,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    CONSTRAINT auth_public_key_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_public_key_public_jwk_check CHECK ((((public_jwk ->> 'alg'::text) = 'ES256'::text) AND (NOT (public_jwk ? 'd'::text)) AND (NOT (public_jwk ? 'k'::text))))
);


--
-- Name: auth_receiving_copy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_receiving_copy (
    obligation_id bigint NOT NULL,
    control_revision bigint NOT NULL,
    workflow_id text NOT NULL,
    sdk_closure_id uuid NOT NULL,
    sdk_closed_at bigint NOT NULL,
    native_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    CONSTRAINT auth_receiving_copy_workflow_id_check CHECK ((octet_length(workflow_id) <= 1024))
);


--
-- Name: auth_receiving_work; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_receiving_work (
    obligation_id bigint NOT NULL,
    control_revision bigint NOT NULL,
    binding jsonb NOT NULL,
    restore_generation text,
    native_xid xid8,
    closure_receipt_id uuid,
    closure_xid xid8,
    CONSTRAINT auth_receiving_work_binding_check CHECK ((octet_length((binding)::text) <= 1024)),
    CONSTRAINT auth_receiving_work_check CHECK (((closure_receipt_id IS NULL) = (closure_xid IS NULL)))
);


--
-- Name: auth_recent_oidc_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_recent_oidc_session (
    session_id text NOT NULL,
    account_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    erasure_client_id text,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_recent_oidc_session_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_recent_oidc_session_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_recent_oidc_session_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: auth_recovery; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_recovery (
    proof_hash text NOT NULL,
    account_id text NOT NULL,
    authn_epoch integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_operation text,
    consumed_verification_id text,
    consumed_at timestamp with time zone,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    CONSTRAINT auth_recovery_authn_epoch_check CHECK ((authn_epoch >= 0)),
    CONSTRAINT auth_recovery_consumption CHECK ((((consumed_operation IS NULL) AND (consumed_verification_id IS NULL) AND (consumed_at IS NULL)) OR ((consumed_operation IS NOT NULL) AND (consumed_verification_id IS NOT NULL) AND (consumed_at IS NOT NULL)))),
    CONSTRAINT auth_recovery_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1])))
);


--
-- Name: auth_recovery_copy_source; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_recovery_copy_source (
    delivery_id text NOT NULL,
    producer text DEFAULT 'better-auth-reset/1.8.0-beta.2/source-v1'::text NOT NULL,
    source_component text DEFAULT 'verification'::text NOT NULL,
    account_id text NOT NULL,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    sink_generation text,
    custody text DEFAULT 'unknown'::text NOT NULL,
    status text DEFAULT 'intent'::text NOT NULL,
    code text DEFAULT 'receiving-adapter-unavailable'::text NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    attempted_at timestamp with time zone,
    erasure_role_version smallint DEFAULT 1 NOT NULL,
    erasure_role_xid bigint NOT NULL,
    CONSTRAINT auth_recovery_copy_source_account_id_check CHECK (((octet_length(account_id) >= 1) AND (octet_length(account_id) <= 1024))),
    CONSTRAINT auth_recovery_copy_source_attempts_check CHECK ((attempts = ANY (ARRAY[0, 1]))),
    CONSTRAINT auth_recovery_copy_source_code_check CHECK ((code = ANY (ARRAY['receiving-adapter-unavailable'::text, 'receiving-result-unavailable'::text, 'legacy-void'::text, 'unsupported-result'::text, 'callback-failed'::text, 'callback-timeout'::text]))),
    CONSTRAINT auth_recovery_copy_source_custody_check CHECK ((custody = 'unknown'::text)),
    CONSTRAINT auth_recovery_copy_source_delivery_id_check CHECK (((octet_length(delivery_id) >= 1) AND (octet_length(delivery_id) <= 1024))),
    CONSTRAINT auth_recovery_copy_source_delivery_id_check1 CHECK ((octet_length((to_json(delivery_id))::text) <= 768)),
    CONSTRAINT auth_recovery_copy_source_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_recovery_copy_source_erasure_human_id_check CHECK ((octet_length(erasure_human_id) <= 1024)),
    CONSTRAINT auth_recovery_copy_source_erasure_operator_id_check CHECK ((octet_length(erasure_operator_id) <= 1024)),
    CONSTRAINT auth_recovery_copy_source_erasure_role_version_check CHECK ((erasure_role_version = 1)),
    CONSTRAINT auth_recovery_copy_source_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024)),
    CONSTRAINT auth_recovery_copy_source_producer_check CHECK ((producer = 'better-auth-reset/1.8.0-beta.2/source-v1'::text)),
    CONSTRAINT auth_recovery_copy_source_sink_generation_check CHECK ((sink_generation IS NULL)),
    CONSTRAINT auth_recovery_copy_source_source_component_check CHECK ((source_component = 'verification'::text)),
    CONSTRAINT auth_recovery_copy_source_status_check CHECK ((status = ANY (ARRAY['intent'::text, 'in-flight'::text, 'unknown'::text])))
);


--
-- Name: auth_recovery_establishment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_recovery_establishment (
    reference text NOT NULL,
    receipt_id text NOT NULL,
    account_id text NOT NULL,
    credential_id text NOT NULL,
    credential_fingerprint text NOT NULL,
    effect_commitment text NOT NULL,
    establishment_id text NOT NULL,
    authn_epoch integer NOT NULL,
    erasure_source_client_id text,
    erasure_client_id text,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_recovery_establishment_authn_epoch_check CHECK ((authn_epoch > 0)),
    CONSTRAINT auth_recovery_establishment_credential_fingerprint_check CHECK ((credential_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT auth_recovery_establishment_effect_commitment_check CHECK ((effect_commitment ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT auth_recovery_establishment_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_recovery_establishment_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_recovery_establishment_erasure_source_client_owner_i_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: auth_registration_stage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_registration_stage (
    registration_id text NOT NULL,
    request_key text NOT NULL,
    handle text NOT NULL,
    account_id text NOT NULL,
    reservation_id text,
    request_digest bytea NOT NULL,
    ciphertext bytea,
    credential_digest bytea,
    expires_at timestamp with time zone,
    completed_at timestamp with time zone,
    expired_at timestamp with time zone,
    pending_reference text,
    automated_reference text,
    creation_binding jsonb,
    erasure_release_at timestamp with time zone,
    erasure_creator_id text,
    erasure_operator_id text,
    consumer_workflow_id text,
    activation_key text,
    operator_reservation_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_delegate_id text,
    erasure_initiator_id text,
    erasure_actor_version smallint DEFAULT 0 NOT NULL,
    creation_context_version smallint DEFAULT 0 NOT NULL,
    creation_scope_digest bytea,
    creation_context jsonb,
    creation_approval_reference text,
    erasure_actor_id text,
    erasure_human_id text,
    erasure_principal_id text,
    erasure_native_operator_id text,
    erasure_client_id text,
    erasure_source_client_id text,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_registration_stage_creation_approval_reference_check CHECK (((octet_length(creation_approval_reference) >= 1) AND (octet_length(creation_approval_reference) <= 4096))),
    CONSTRAINT auth_registration_stage_creation_context_version_check CHECK ((creation_context_version = ANY (ARRAY[0, 1]))),
    CONSTRAINT auth_registration_stage_creation_scope_digest_check CHECK ((octet_length(creation_scope_digest) = 32)),
    CONSTRAINT auth_registration_stage_erasure_actor_id_check CHECK (((octet_length(erasure_actor_id) >= 1) AND (octet_length(erasure_actor_id) <= 1024))),
    CONSTRAINT auth_registration_stage_erasure_actor_version_check CHECK ((erasure_actor_version = ANY (ARRAY[0, 1]))),
    CONSTRAINT auth_registration_stage_erasure_client_id_check CHECK (((octet_length(erasure_client_id) >= 1) AND (octet_length(erasure_client_id) <= 1024))),
    CONSTRAINT auth_registration_stage_erasure_client_owner_id_check CHECK (((octet_length(erasure_client_owner_id) >= 1) AND (octet_length(erasure_client_owner_id) <= 1024))),
    CONSTRAINT auth_registration_stage_erasure_delegate_id_check CHECK ((octet_length(erasure_delegate_id) <= 1024)),
    CONSTRAINT auth_registration_stage_erasure_human_id_check CHECK (((octet_length(erasure_human_id) >= 1) AND (octet_length(erasure_human_id) <= 1024))),
    CONSTRAINT auth_registration_stage_erasure_initiator_id_check CHECK ((octet_length(erasure_initiator_id) <= 1024)),
    CONSTRAINT auth_registration_stage_erasure_native_operator_id_check CHECK (((octet_length(erasure_native_operator_id) >= 1) AND (octet_length(erasure_native_operator_id) <= 1024))),
    CONSTRAINT auth_registration_stage_erasure_principal_id_check CHECK (((octet_length(erasure_principal_id) >= 1) AND (octet_length(erasure_principal_id) <= 1024))),
    CONSTRAINT auth_registration_stage_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_registration_stage_erasure_source_client_id_check CHECK (((octet_length(erasure_source_client_id) >= 1) AND (octet_length(erasure_source_client_id) <= 1024))),
    CONSTRAINT auth_registration_stage_erasure_source_client_owner_id_check CHECK (((octet_length(erasure_source_client_owner_id) >= 1) AND (octet_length(erasure_source_client_owner_id) <= 1024)))
);


--
-- Name: auth_restore_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_restore_generation (
    generation text NOT NULL,
    inventory jsonb,
    native_coverage_started boolean DEFAULT false NOT NULL,
    source_cut_id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_cut jsonb,
    source_cursor jsonb DEFAULT '{"partition": 0, "afterOrdinal": "0"}'::jsonb,
    source_verify_partition integer DEFAULT 0 NOT NULL,
    source_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT auth_restore_generation_check CHECK (((NOT native_coverage_started) OR (inventory IS NOT NULL))),
    CONSTRAINT auth_restore_generation_generation_check CHECK (((octet_length(generation) >= 1) AND (octet_length(generation) <= 1024))),
    CONSTRAINT auth_restore_generation_inventory_check CHECK ((octet_length((inventory)::text) <= 16384)),
    CONSTRAINT auth_restore_generation_source_cursor_check CHECK ((octet_length((source_cursor)::text) <= 128)),
    CONSTRAINT auth_restore_generation_source_cut_check CHECK ((octet_length((source_cut)::text) <= 1024)),
    CONSTRAINT auth_restore_generation_source_revision_check CHECK ((source_revision >= 0)),
    CONSTRAINT auth_restore_generation_source_verify_partition_check CHECK (((source_verify_partition >= 0) AND (source_verify_partition <= 4096)))
);


--
-- Name: auth_restore_live_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_restore_live_generation (
    generation text NOT NULL,
    inventory jsonb NOT NULL,
    source_cut_id uuid NOT NULL,
    live_partition integer DEFAULT 0 NOT NULL,
    live_verified_partitions integer DEFAULT 0 NOT NULL,
    reconcile_turn integer DEFAULT 0 NOT NULL,
    replay_after bigint DEFAULT 0 NOT NULL,
    replay_inventory_after bigint DEFAULT 0 NOT NULL,
    replay_inventory_complete boolean DEFAULT false NOT NULL,
    CONSTRAINT auth_restore_live_generation_generation_check CHECK (((octet_length(generation) >= 1) AND (octet_length(generation) <= 1024))),
    CONSTRAINT auth_restore_live_generation_inventory_check CHECK ((octet_length((inventory)::text) <= 16384)),
    CONSTRAINT auth_restore_live_generation_live_partition_check CHECK (((live_partition >= 0) AND (live_partition <= 4095))),
    CONSTRAINT auth_restore_live_generation_live_verified_partitions_check CHECK (((live_verified_partitions >= 0) AND (live_verified_partitions <= 4096))),
    CONSTRAINT auth_restore_live_generation_reconcile_turn_check CHECK ((reconcile_turn = ANY (ARRAY[0, 1]))),
    CONSTRAINT auth_restore_live_generation_replay_after_check CHECK ((replay_after >= 0)),
    CONSTRAINT auth_restore_live_generation_replay_inventory_after_check CHECK ((replay_inventory_after >= 0))
);


--
-- Name: auth_restore_live_partition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_restore_live_partition (
    generation text NOT NULL,
    partition integer NOT NULL,
    arm jsonb NOT NULL,
    after_ordinal bigint NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    page jsonb,
    verification jsonb,
    verified boolean DEFAULT false NOT NULL,
    CONSTRAINT auth_restore_live_partition_after_ordinal_check CHECK ((after_ordinal >= 0)),
    CONSTRAINT auth_restore_live_partition_arm_check CHECK ((octet_length((arm)::text) <= 8192)),
    CONSTRAINT auth_restore_live_partition_page_check CHECK ((octet_length((page)::text) <= 65536)),
    CONSTRAINT auth_restore_live_partition_partition_check CHECK (((partition >= 0) AND (partition <= 4095))),
    CONSTRAINT auth_restore_live_partition_revision_check CHECK ((revision >= 0)),
    CONSTRAINT auth_restore_live_partition_verification_check CHECK ((octet_length((verification)::text) <= 8192))
);


--
-- Name: auth_restore_live_work; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_restore_live_work (
    generation text NOT NULL,
    obligation_id bigint NOT NULL,
    state text DEFAULT 'native'::text NOT NULL,
    CONSTRAINT auth_restore_live_work_obligation_id_check CHECK ((obligation_id > 0)),
    CONSTRAINT auth_restore_live_work_state_check CHECK ((state = ANY (ARRAY['native'::text, 'receiving'::text, 'external'::text])))
);


--
-- Name: auth_restore_replay; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_restore_replay (
    generation text NOT NULL,
    obligation_id bigint NOT NULL,
    original_progress jsonb NOT NULL,
    phase integer DEFAULT 0 NOT NULL,
    after_key text DEFAULT ''::text NOT NULL,
    client_id text,
    client_phase integer DEFAULT 0 NOT NULL,
    user_replayed boolean DEFAULT false NOT NULL,
    native_completed_at timestamp with time zone,
    consent_completed_at timestamp with time zone,
    copies_completed_at timestamp with time zone,
    pending_code text DEFAULT 'native'::text NOT NULL,
    source_obligation jsonb,
    CONSTRAINT auth_restore_replay_after_key_check CHECK ((octet_length(after_key) <= 1024)),
    CONSTRAINT auth_restore_replay_client_id_check CHECK ((octet_length(client_id) <= 1024)),
    CONSTRAINT auth_restore_replay_original_progress_check CHECK ((octet_length((original_progress)::text) <= 16384)),
    CONSTRAINT auth_restore_replay_source_obligation_check CHECK ((octet_length((source_obligation)::text) <= 1024))
);


--
-- Name: auth_restore_source_partition; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_restore_source_partition (
    generation text NOT NULL,
    partition integer NOT NULL,
    page jsonb NOT NULL,
    verification jsonb,
    CONSTRAINT auth_restore_source_partition_page_check CHECK ((octet_length((page)::text) <= 65536)),
    CONSTRAINT auth_restore_source_partition_partition_check CHECK (((partition >= 0) AND (partition <= 4095))),
    CONSTRAINT auth_restore_source_partition_verification_check CHECK ((octet_length((verification)::text) <= 2048))
);


--
-- Name: auth_session_opening; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_session_opening (
    session_id text NOT NULL,
    subject_account_id text NOT NULL,
    acting_human_id text NOT NULL,
    operator_account_id text NOT NULL,
    receipt_id text NOT NULL,
    opened_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    erasure_client_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT auth_session_opening_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_session_opening_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_session_opening_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: auth_signing_generation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_signing_generation (
    singleton boolean DEFAULT true NOT NULL,
    generation integer DEFAULT 0 NOT NULL,
    current_kid text,
    next_kid text,
    retiring_kid text,
    upgrade_after timestamp with time zone NOT NULL,
    CONSTRAINT auth_signing_generation_generation_check CHECK ((generation >= 0)),
    CONSTRAINT auth_signing_generation_singleton_check CHECK (singleton)
);


--
-- Name: auth_signing_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_signing_key (
    kid text CONSTRAINT auth_signing_key_kid_not_null1 NOT NULL,
    slot text NOT NULL,
    private_jwk jsonb CONSTRAINT auth_signing_key_private_jwk_not_null1 NOT NULL,
    retain_until timestamp with time zone,
    CONSTRAINT auth_signing_key_check CHECK (((slot = 'retiring'::text) = (retain_until IS NOT NULL))),
    CONSTRAINT auth_signing_key_private_jwk_check1 CHECK (((private_jwk ->> 'd'::text) IS NOT NULL)),
    CONSTRAINT auth_signing_key_slot_check CHECK ((slot = ANY (ARRAY['current'::text, 'next'::text, 'retiring'::text])))
);


--
-- Name: auth_signing_key_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_signing_key_archive (
    kid text CONSTRAINT auth_signing_key_kid_not_null NOT NULL,
    private_jwk jsonb CONSTRAINT auth_signing_key_private_jwk_not_null NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP CONSTRAINT auth_signing_key_created_at_not_null NOT NULL,
    CONSTRAINT auth_signing_key_private_jwk_check CHECK (((private_jwk ->> 'd'::text) IS NOT NULL))
);


--
-- Name: auth_traversal_ordinal; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.auth_traversal_ordinal
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: auth_workflow_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_workflow_request (
    workflow_id text NOT NULL,
    digest bytea NOT NULL,
    request jsonb NOT NULL,
    erasure_subject_id text,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_client_id text,
    erasure_member_id text,
    erasure_previous_operator_id text,
    terminal_at timestamp with time zone,
    erasure_stage_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    erasure_delegate_id text,
    erasure_initiator_id text,
    erasure_actor_version smallint DEFAULT 0 NOT NULL,
    erasure_actor_id text,
    erasure_principal_id text,
    erasure_source_client_id text,
    request_party_version smallint DEFAULT 0 NOT NULL,
    request_context_version smallint DEFAULT 0 NOT NULL,
    CONSTRAINT auth_request_party_context CHECK (((request_party_version = 0) OR ((request_context_version = 1) AND (erasure_actor_version = 1) AND (erasure_actor_id IS NOT NULL) AND (erasure_source_client_id IS NOT NULL)))),
    CONSTRAINT auth_workflow_request_erasure_actor_id_check CHECK (((octet_length(erasure_actor_id) >= 1) AND (octet_length(erasure_actor_id) <= 1024))),
    CONSTRAINT auth_workflow_request_erasure_actor_version_check CHECK ((erasure_actor_version = ANY (ARRAY[0, 1]))),
    CONSTRAINT auth_workflow_request_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT auth_workflow_request_erasure_delegate_id_check CHECK ((octet_length(erasure_delegate_id) <= 1024)),
    CONSTRAINT auth_workflow_request_erasure_initiator_id_check CHECK ((octet_length(erasure_initiator_id) <= 1024)),
    CONSTRAINT auth_workflow_request_erasure_principal_id_check CHECK (((octet_length(erasure_principal_id) >= 1) AND (octet_length(erasure_principal_id) <= 1024))),
    CONSTRAINT auth_workflow_request_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT auth_workflow_request_erasure_source_client_id_check CHECK (((octet_length(erasure_source_client_id) >= 1) AND (octet_length(erasure_source_client_id) <= 1024))),
    CONSTRAINT auth_workflow_request_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024)),
    CONSTRAINT auth_workflow_request_request_context_version_check CHECK ((request_context_version = ANY (ARRAY[0, 1]))),
    CONSTRAINT auth_workflow_request_request_party_version_check CHECK ((request_party_version = ANY (ARRAY[0, 1])))
);


--
-- Name: jwks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jwks (
    id text NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "expiresAt" timestamp with time zone,
    alg text,
    crv text
);


--
-- Name: oauthAccessToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthAccessToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text,
    "referenceId" text,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "refreshId" text,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    confirmation jsonb,
    scopes jsonb NOT NULL,
    erasure_source_client_id text,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT "oauthAccessToken_erasure_client_owner_id_check" CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT "oauthAccessToken_erasure_role_version_check" CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT "oauthAccessToken_erasure_source_client_owner_id_check" CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: oauthClientAssertion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthClientAssertion" (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    erasure_client_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT "oauthClientAssertion_erasure_client_owner_id_check" CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT "oauthClientAssertion_erasure_role_version_check" CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT "oauthClientAssertion_erasure_source_client_owner_id_check" CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: oauthClientResource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthClientResource" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "resourceId" text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp with time zone,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT "oauthClientResource_erasure_client_owner_id_check" CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT "oauthClientResource_erasure_role_version_check" CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT "oauthClientResource_erasure_source_client_owner_id_check" CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: oauthRefreshFamily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthRefreshFamily" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    revoked boolean NOT NULL,
    sequence integer NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    erasure_source_client_id text,
    erasure_account_id text,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT "oauthRefreshFamily_erasure_client_owner_id_check" CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT "oauthRefreshFamily_erasure_role_version_check" CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT "oauthRefreshFamily_erasure_source_client_owner_id_check" CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: oauthRefreshToken; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthRefreshToken" (
    id text NOT NULL,
    token text NOT NULL,
    "clientId" text NOT NULL,
    "sessionId" text,
    "userId" text NOT NULL,
    "referenceId" text,
    "authorizationCodeId" text,
    resources jsonb,
    "requestedUserInfoClaims" jsonb,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    revoked timestamp with time zone,
    "rotatedAt" timestamp with time zone,
    "rotationReplayResponse" text,
    "rotationReplayExpiresAt" timestamp with time zone,
    "authTime" timestamp with time zone,
    acr text,
    amr jsonb,
    confirmation jsonb,
    scopes jsonb NOT NULL,
    erasure_source_client_id text,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT "oauthRefreshToken_erasure_client_owner_id_check" CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT "oauthRefreshToken_erasure_role_version_check" CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT "oauthRefreshToken_erasure_source_client_owner_id_check" CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: oauthResource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthResource" (
    id text NOT NULL,
    identifier text NOT NULL,
    name text NOT NULL,
    "accessTokenTtl" integer,
    "refreshTokenTtl" integer,
    "signingAlgorithm" text,
    "signingKeyId" text,
    "allowedScopes" jsonb,
    "customClaims" jsonb,
    "dpopBoundAccessTokensRequired" boolean,
    disabled boolean,
    "createdAt" timestamp with time zone,
    "updatedAt" timestamp with time zone,
    "policyVersion" integer,
    metadata jsonb,
    name_writer integer
);


--
-- Name: passkey; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.passkey (
    id text NOT NULL,
    name text,
    "publicKey" text NOT NULL,
    "userId" text NOT NULL,
    "credentialID" text NOT NULL,
    counter bigint NOT NULL,
    "deviceType" text NOT NULL,
    "backedUp" boolean NOT NULL,
    transports text,
    "createdAt" timestamp with time zone NOT NULL,
    aaguid text,
    last_used_at timestamp with time zone,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    CONSTRAINT passkey_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1])))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    "clientId" text NOT NULL,
    "grantedScope" text NOT NULL,
    "authnEpoch" integer NOT NULL,
    "authTime" integer NOT NULL,
    "authMethods" text NOT NULL,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    CONSTRAINT session_authentication CHECK ((("authnEpoch" >= 0) AND ("authTime" >= 0) AND ("authMethods" = ANY (ARRAY['pwd'::text, 'pop'::text, 'private_key_jwt'::text, 'operator'::text])))),
    CONSTRAINT session_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT session_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT session_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    sessions_bounded boolean DEFAULT true NOT NULL,
    traversal_ordinal bigint,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    CONSTRAINT inert_profile CHECK (((name = ''::text) AND (image IS NULL))),
    CONSTRAINT user_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1])))
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    erasure_source_client_id text,
    erasure_account_id text,
    erasure_client_id text,
    erasure_session_id text,
    erasure_human_id text,
    erasure_operator_id text,
    erasure_role_version smallint DEFAULT 0 NOT NULL,
    erasure_role_xid bigint,
    erasure_client_owner_id text,
    erasure_source_client_owner_id text,
    erasure_format text,
    CONSTRAINT verification_erasure_client_owner_id_check CHECK ((octet_length(erasure_client_owner_id) <= 1024)),
    CONSTRAINT verification_erasure_format_check CHECK ((erasure_format = ANY (ARRAY['reset-v1'::text, 'webauthn-v1'::text, 'webauthn-anonymous-v1'::text, 'code-v1'::text, 'unknown'::text]))),
    CONSTRAINT verification_erasure_role_version_check CHECK ((erasure_role_version = ANY (ARRAY['-1'::integer, 0, 1]))),
    CONSTRAINT verification_erasure_source_client_owner_id_check CHECK ((octet_length(erasure_source_client_owner_id) <= 1024))
);


--
-- Name: auth_kind_consent_dependency enrollment_seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_kind_consent_dependency ALTER COLUMN enrollment_seq SET DEFAULT nextval('public.auth_kind_consent_dependency_enrollment_seq_seq'::regclass);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: auth_attempt_account auth_attempt_account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_attempt_account
    ADD CONSTRAINT auth_attempt_account_pkey PRIMARY KEY (account_id, key);


--
-- Name: auth_attempt_counter auth_attempt_counter_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_attempt_counter
    ADD CONSTRAINT auth_attempt_counter_pkey PRIMARY KEY (key);


--
-- Name: auth_barrier_proof auth_barrier_proof_account_id_purpose_operation_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_barrier_proof
    ADD CONSTRAINT auth_barrier_proof_account_id_purpose_operation_key_key UNIQUE (account_id, purpose, operation_key);


--
-- Name: auth_barrier_proof auth_barrier_proof_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_barrier_proof
    ADD CONSTRAINT auth_barrier_proof_pkey PRIMARY KEY (reference);


--
-- Name: auth_client_coverage auth_client_coverage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_coverage
    ADD CONSTRAINT auth_client_coverage_pkey PRIMARY KEY (client_id);


--
-- Name: auth_client auth_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client
    ADD CONSTRAINT auth_client_id_key UNIQUE (id);


--
-- Name: auth_client auth_client_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client
    ADD CONSTRAINT auth_client_pkey PRIMARY KEY (client_id);


--
-- Name: auth_client_reduction auth_client_reduction_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction
    ADD CONSTRAINT auth_client_reduction_operation_id_key UNIQUE (operation_id);


--
-- Name: auth_client_reduction auth_client_reduction_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction
    ADD CONSTRAINT auth_client_reduction_pkey PRIMARY KEY (client_id);


--
-- Name: auth_client_reduction_progress auth_client_reduction_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction_progress
    ADD CONSTRAINT auth_client_reduction_progress_pkey PRIMARY KEY (operation_id);


--
-- Name: auth_consent_erasure auth_consent_erasure_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_consent_erasure
    ADD CONSTRAINT auth_consent_erasure_pkey PRIMARY KEY (account_id);


--
-- Name: auth_consent auth_consent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_consent
    ADD CONSTRAINT auth_consent_id_key UNIQUE (id);


--
-- Name: auth_consent auth_consent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_consent
    ADD CONSTRAINT auth_consent_pkey PRIMARY KEY (account_id, client_id);


--
-- Name: auth_copy_artifact auth_copy_artifact_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_copy_artifact
    ADD CONSTRAINT auth_copy_artifact_pkey PRIMARY KEY (workflow_id, kind, key);


--
-- Name: auth_copy_coverage auth_copy_coverage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_copy_coverage
    ADD CONSTRAINT auth_copy_coverage_pkey PRIMARY KEY (singleton);


--
-- Name: auth_copy_role auth_copy_role_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_copy_role
    ADD CONSTRAINT auth_copy_role_pkey PRIMARY KEY (account_id, workflow_id, role);


--
-- Name: auth_copy_work auth_copy_work_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_copy_work
    ADD CONSTRAINT auth_copy_work_pkey PRIMARY KEY (workflow_id);


--
-- Name: auth_effect_receipt auth_effect_receipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_effect_receipt
    ADD CONSTRAINT auth_effect_receipt_pkey PRIMARY KEY (receipt_id);


--
-- Name: auth_erased_client auth_erased_client_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_erased_client
    ADD CONSTRAINT auth_erased_client_pkey PRIMARY KEY (client_id);


--
-- Name: auth_erasure auth_erasure_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_erasure
    ADD CONSTRAINT auth_erasure_account_id_key UNIQUE (account_id);


--
-- Name: auth_erasure_cursor_cutover auth_erasure_cursor_cutover_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_erasure_cursor_cutover
    ADD CONSTRAINT auth_erasure_cursor_cutover_pkey PRIMARY KEY (singleton);


--
-- Name: auth_erasure auth_erasure_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_erasure
    ADD CONSTRAINT auth_erasure_pkey PRIMARY KEY (id);


--
-- Name: auth_key_assertion auth_key_assertion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_key_assertion
    ADD CONSTRAINT auth_key_assertion_pkey PRIMARY KEY (account_id, jti);


--
-- Name: auth_kind_consent_dependency auth_kind_consent_dependency_consumer_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_kind_consent_dependency
    ADD CONSTRAINT auth_kind_consent_dependency_consumer_key_hash_key UNIQUE (consumer_key_hash);


--
-- Name: auth_kind_consent_dependency auth_kind_consent_dependency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_kind_consent_dependency
    ADD CONSTRAINT auth_kind_consent_dependency_pkey PRIMARY KEY (enrollment_seq);


--
-- Name: auth_kind_consent_dependency auth_kind_consent_dependency_reference_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_kind_consent_dependency
    ADD CONSTRAINT auth_kind_consent_dependency_reference_id_key UNIQUE (reference_id);


--
-- Name: auth_kind_consent_transition auth_kind_consent_transition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_kind_consent_transition
    ADD CONSTRAINT auth_kind_consent_transition_pkey PRIMARY KEY (transition_id);


--
-- Name: auth_kind_consent_transition auth_kind_consent_transition_transition_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_kind_consent_transition
    ADD CONSTRAINT auth_kind_consent_transition_transition_key_key UNIQUE (transition_key);


--
-- Name: auth_metadata_scrub auth_metadata_scrub_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_metadata_scrub
    ADD CONSTRAINT auth_metadata_scrub_pkey PRIMARY KEY (store);


--
-- Name: auth_native_consumer_proof auth_native_consumer_proof_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_native_consumer_proof
    ADD CONSTRAINT auth_native_consumer_proof_pkey PRIMARY KEY (store, key);


--
-- Name: auth_native_credential_terminal auth_native_credential_terminal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_native_credential_terminal
    ADD CONSTRAINT auth_native_credential_terminal_pkey PRIMARY KEY (receipt_id);


--
-- Name: auth_native_phase_deployment auth_native_phase_deployment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_native_phase_deployment
    ADD CONSTRAINT auth_native_phase_deployment_pkey PRIMARY KEY (singleton);


--
-- Name: auth_native_role_deployment auth_native_role_deployment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_native_role_deployment
    ADD CONSTRAINT auth_native_role_deployment_pkey PRIMARY KEY (singleton);


--
-- Name: auth_native_role_unknown auth_native_role_unknown_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_native_role_unknown
    ADD CONSTRAINT auth_native_role_unknown_pkey PRIMARY KEY (store, reason);


--
-- Name: auth_provisioning_receipt auth_provisioning_receipt_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_provisioning_receipt
    ADD CONSTRAINT auth_provisioning_receipt_account_id_key UNIQUE (account_id);


--
-- Name: auth_provisioning_receipt auth_provisioning_receipt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_provisioning_receipt
    ADD CONSTRAINT auth_provisioning_receipt_pkey PRIMARY KEY (idempotency_key);


--
-- Name: auth_public_key auth_public_key_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_public_key
    ADD CONSTRAINT auth_public_key_pkey PRIMARY KEY (account_id, kid);


--
-- Name: auth_receiving_copy auth_receiving_copy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_receiving_copy
    ADD CONSTRAINT auth_receiving_copy_pkey PRIMARY KEY (obligation_id, control_revision, workflow_id);


--
-- Name: auth_receiving_work auth_receiving_work_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_receiving_work
    ADD CONSTRAINT auth_receiving_work_pkey PRIMARY KEY (obligation_id, control_revision);


--
-- Name: auth_recent_oidc_session auth_recent_oidc_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recent_oidc_session
    ADD CONSTRAINT auth_recent_oidc_session_pkey PRIMARY KEY (session_id);


--
-- Name: auth_recovery_copy_source auth_recovery_copy_source_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_copy_source
    ADD CONSTRAINT auth_recovery_copy_source_pkey PRIMARY KEY (delivery_id);


--
-- Name: auth_recovery_establishment auth_recovery_establishment_establishment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_establishment
    ADD CONSTRAINT auth_recovery_establishment_establishment_id_key UNIQUE (establishment_id);


--
-- Name: auth_recovery_establishment auth_recovery_establishment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_establishment
    ADD CONSTRAINT auth_recovery_establishment_pkey PRIMARY KEY (reference);


--
-- Name: auth_recovery_establishment auth_recovery_establishment_receipt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_establishment
    ADD CONSTRAINT auth_recovery_establishment_receipt_id_key UNIQUE (receipt_id);


--
-- Name: auth_recovery auth_recovery_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery
    ADD CONSTRAINT auth_recovery_pkey PRIMARY KEY (proof_hash);


--
-- Name: auth_registration_stage auth_registration_stage_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_registration_stage
    ADD CONSTRAINT auth_registration_stage_account_id_key UNIQUE (account_id);


--
-- Name: auth_registration_stage auth_registration_stage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_registration_stage
    ADD CONSTRAINT auth_registration_stage_pkey PRIMARY KEY (registration_id);


--
-- Name: auth_registration_stage auth_registration_stage_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_registration_stage
    ADD CONSTRAINT auth_registration_stage_request_key_key UNIQUE (request_key);


--
-- Name: auth_restore_generation auth_restore_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_generation
    ADD CONSTRAINT auth_restore_generation_pkey PRIMARY KEY (generation);


--
-- Name: auth_restore_live_generation auth_restore_live_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_live_generation
    ADD CONSTRAINT auth_restore_live_generation_pkey PRIMARY KEY (generation);


--
-- Name: auth_restore_live_partition auth_restore_live_partition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_live_partition
    ADD CONSTRAINT auth_restore_live_partition_pkey PRIMARY KEY (generation, partition);


--
-- Name: auth_restore_live_work auth_restore_live_work_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_live_work
    ADD CONSTRAINT auth_restore_live_work_pkey PRIMARY KEY (generation, obligation_id);


--
-- Name: auth_restore_replay auth_restore_replay_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_replay
    ADD CONSTRAINT auth_restore_replay_pkey PRIMARY KEY (generation, obligation_id);


--
-- Name: auth_restore_source_partition auth_restore_source_partition_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_source_partition
    ADD CONSTRAINT auth_restore_source_partition_pkey PRIMARY KEY (generation, partition);


--
-- Name: auth_session_opening auth_session_opening_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_opening
    ADD CONSTRAINT auth_session_opening_pkey PRIMARY KEY (session_id);


--
-- Name: auth_session_opening auth_session_opening_receipt_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_opening
    ADD CONSTRAINT auth_session_opening_receipt_id_key UNIQUE (receipt_id);


--
-- Name: auth_signing_generation auth_signing_generation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_signing_generation
    ADD CONSTRAINT auth_signing_generation_pkey PRIMARY KEY (singleton);


--
-- Name: auth_signing_key_archive auth_signing_key_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_signing_key_archive
    ADD CONSTRAINT auth_signing_key_archive_pkey PRIMARY KEY (kid);


--
-- Name: auth_signing_key auth_signing_key_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_signing_key
    ADD CONSTRAINT auth_signing_key_pkey PRIMARY KEY (kid);


--
-- Name: auth_signing_key auth_signing_key_slot_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_signing_key
    ADD CONSTRAINT auth_signing_key_slot_key UNIQUE (slot);


--
-- Name: auth_workflow_request auth_workflow_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_workflow_request
    ADD CONSTRAINT auth_workflow_request_pkey PRIMARY KEY (workflow_id);


--
-- Name: account credential_owner_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT credential_owner_unique UNIQUE ("userId", "providerId");


--
-- Name: jwks jwks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);


--
-- Name: oauthAccessToken oauthAccessToken_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthAccessToken oauthAccessToken_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_token_key" UNIQUE (token);


--
-- Name: oauthClientAssertion oauthClientAssertion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClientAssertion"
    ADD CONSTRAINT "oauthClientAssertion_pkey" PRIMARY KEY (id);


--
-- Name: oauthClientResource oauthClientResource_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshFamily oauthRefreshFamily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthRefreshFamily"
    ADD CONSTRAINT "oauthRefreshFamily_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshToken oauthRefreshToken_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_pkey" PRIMARY KEY (id);


--
-- Name: oauthRefreshToken oauthRefreshToken_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_token_key" UNIQUE (token);


--
-- Name: oauthResource oauthResource_identifier_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthResource"
    ADD CONSTRAINT "oauthResource_identifier_key" UNIQUE (identifier);


--
-- Name: oauthResource oauthResource_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthResource"
    ADD CONSTRAINT "oauthResource_pkey" PRIMARY KEY (id);


--
-- Name: passkey passkey_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT passkey_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "account_userId_idx" ON public.account USING btree ("userId");


--
-- Name: auth_attempt_counter_retention; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_attempt_counter_retention ON public.auth_attempt_counter USING btree (last_request, key);


--
-- Name: auth_barrier_proof_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_barrier_proof_expiry ON public.auth_barrier_proof USING btree (expires_at, reference);


--
-- Name: auth_client_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "auth_client_userId_idx" ON public.auth_client USING btree ("userId");


--
-- Name: auth_consent_client_ordinal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_consent_client_ordinal ON public.auth_consent USING btree (client_id, traversal_ordinal) INCLUDE (account_id);


--
-- Name: auth_consent_client_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_consent_client_owner ON public.auth_consent USING btree (client_id, account_id);


--
-- Name: auth_consent_erasure_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_consent_erasure_due ON public.auth_consent_erasure USING btree (due_at, account_id);


--
-- Name: auth_copy_role_work; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_copy_role_work ON public.auth_copy_role USING btree (workflow_id, account_id, role);


--
-- Name: auth_credential_operation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_credential_operation ON public.auth_effect_receipt USING btree (account_id, operation_key) WHERE (operation_key IS NOT NULL);


--
-- Name: auth_credential_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_credential_reference ON public.auth_effect_receipt USING btree (effect_reference) WHERE (effect_reference IS NOT NULL);


--
-- Name: auth_erasure_copy_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_erasure_copy_pending ON public.auth_erasure USING btree (revision, id) WHERE (copies_published_at IS NULL);


--
-- Name: auth_erasure_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_erasure_pending ON public.auth_erasure USING btree (revision, id) WHERE ((native_completed_at IS NULL) OR (native_role_version = 0) OR (native_phase_version < 3) OR (phase < 102));


--
-- Name: auth_kind_consent_by_account_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_kind_consent_by_account_client ON public.auth_kind_consent_dependency USING btree (account_id, client_id, enrollment_seq) WHERE active;


--
-- Name: auth_kind_consent_by_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_kind_consent_by_client ON public.auth_kind_consent_dependency USING btree (client_id, enrollment_seq) WHERE active;


--
-- Name: auth_kind_consent_transition_pending_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_kind_consent_transition_pending_client ON public.auth_kind_consent_transition USING btree (client_id, account_id, transition_id) WHERE (state <> 'applied'::text);


--
-- Name: auth_native_proof_provisioning_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_native_proof_provisioning_stage ON public.auth_provisioning_receipt USING btree (erasure_stage_id, idempotency_key);


--
-- Name: auth_native_proof_request_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_native_proof_request_stage ON public.auth_workflow_request USING btree (erasure_stage_id, workflow_id);


--
-- Name: auth_provisioning_receipt_credential_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_provisioning_receipt_credential_idx ON public.auth_provisioning_receipt USING btree (credential_id);


--
-- Name: auth_provisioning_receipt_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_provisioning_receipt_owner_idx ON public.auth_provisioning_receipt USING btree (owner_id);


--
-- Name: auth_recent_oidc_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_recent_oidc_expiry ON public.auth_recent_oidc_session USING btree (expires_at, session_id);


--
-- Name: auth_recovery_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_recovery_account_id_idx ON public.auth_recovery USING btree (account_id);


--
-- Name: auth_registration_stage_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_registration_stage_due ON public.auth_registration_stage USING btree (expires_at, registration_id) WHERE ((completed_at IS NULL) AND (expired_at IS NULL));


--
-- Name: auth_restore_live_work_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_restore_live_work_pending ON public.auth_restore_live_work USING btree (generation, obligation_id) WHERE (state <> 'external'::text);


--
-- Name: auth_restore_live_work_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_restore_live_work_state ON public.auth_restore_live_work USING btree (generation, state, obligation_id);


--
-- Name: auth_session_opening_subject_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_session_opening_subject_account_id_idx ON public.auth_session_opening USING btree (subject_account_id);


--
-- Name: auth_user_ordinal; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_user_ordinal ON public."user" USING btree (traversal_ordinal) INCLUDE (id);


--
-- Name: auth_workflow_request_automated_registration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_workflow_request_automated_registration ON public.auth_workflow_request USING btree (((request ->> 'registrationId'::text))) WHERE ((request ->> 'kind'::text) = 'automated'::text);


--
-- Name: creation_receipt_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_receipt_actor ON public.auth_provisioning_receipt USING btree (erasure_actor_id, idempotency_key);


--
-- Name: creation_receipt_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_receipt_client ON public.auth_provisioning_receipt USING btree (erasure_client_id, idempotency_key);


--
-- Name: creation_receipt_client_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_receipt_client_owner ON public.auth_provisioning_receipt USING btree (erasure_client_owner_id, idempotency_key);


--
-- Name: creation_receipt_human; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_receipt_human ON public.auth_provisioning_receipt USING btree (erasure_human_id, idempotency_key);


--
-- Name: creation_receipt_native_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_receipt_native_operator ON public.auth_provisioning_receipt USING btree (erasure_native_operator_id, idempotency_key);


--
-- Name: creation_receipt_principal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_receipt_principal ON public.auth_provisioning_receipt USING btree (erasure_principal_id, idempotency_key);


--
-- Name: creation_receipt_source_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_receipt_source_client ON public.auth_provisioning_receipt USING btree (erasure_source_client_id, idempotency_key);


--
-- Name: creation_receipt_source_client_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_receipt_source_client_owner ON public.auth_provisioning_receipt USING btree (erasure_source_client_owner_id, idempotency_key);


--
-- Name: creation_receipt_unknown; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_receipt_unknown ON public.auth_provisioning_receipt USING btree (idempotency_key) WHERE (creation_context_version = 0);


--
-- Name: creation_stage_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_stage_actor ON public.auth_registration_stage USING btree (erasure_actor_id, registration_id);


--
-- Name: creation_stage_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_stage_client ON public.auth_registration_stage USING btree (erasure_client_id, registration_id);


--
-- Name: creation_stage_client_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_stage_client_owner ON public.auth_registration_stage USING btree (erasure_client_owner_id, registration_id);


--
-- Name: creation_stage_human; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_stage_human ON public.auth_registration_stage USING btree (erasure_human_id, registration_id);


--
-- Name: creation_stage_native_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_stage_native_operator ON public.auth_registration_stage USING btree (erasure_native_operator_id, registration_id);


--
-- Name: creation_stage_principal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_stage_principal ON public.auth_registration_stage USING btree (erasure_principal_id, registration_id);


--
-- Name: creation_stage_source_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_stage_source_client ON public.auth_registration_stage USING btree (erasure_source_client_id, registration_id);


--
-- Name: creation_stage_source_client_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_stage_source_client_owner ON public.auth_registration_stage USING btree (erasure_source_client_owner_id, registration_id);


--
-- Name: creation_stage_unknown; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX creation_stage_unknown ON public.auth_registration_stage USING btree (registration_id) WHERE (creation_context_version = 0);


--
-- Name: erasure_account_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_account_0 ON public.account USING btree ("userId", id);


--
-- Name: erasure_auth_barrier_proof_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_barrier_proof_0 ON public.auth_barrier_proof USING btree (account_id, reference);


--
-- Name: erasure_auth_barrier_proof_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_barrier_proof_1 ON public.auth_barrier_proof USING btree (erasure_client_id, reference);


--
-- Name: erasure_auth_barrier_proof_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_barrier_proof_2 ON public.auth_barrier_proof USING btree (erasure_session_id, reference);


--
-- Name: erasure_auth_barrier_proof_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_barrier_proof_3 ON public.auth_barrier_proof USING btree (erasure_human_id, reference);


--
-- Name: erasure_auth_barrier_proof_4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_barrier_proof_4 ON public.auth_barrier_proof USING btree (erasure_operator_id, reference);


--
-- Name: erasure_auth_barrier_proof_source_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_barrier_proof_source_client ON public.auth_barrier_proof USING btree (erasure_source_client_id, reference);


--
-- Name: erasure_auth_client_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_client_0 ON public.auth_client USING btree ("userId", client_id);


--
-- Name: erasure_auth_client_reduction_progress_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_client_reduction_progress_0 ON public.auth_client_reduction_progress USING btree (client_id, operation_id);


--
-- Name: erasure_auth_effect_receipt_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_effect_receipt_0 ON public.auth_effect_receipt USING btree (account_id, receipt_id);


--
-- Name: erasure_auth_effect_receipt_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_effect_receipt_1 ON public.auth_effect_receipt USING btree (acting_human_id, receipt_id);


--
-- Name: erasure_auth_effect_receipt_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_effect_receipt_2 ON public.auth_effect_receipt USING btree (client_id, receipt_id);


--
-- Name: erasure_auth_effect_receipt_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_effect_receipt_3 ON public.auth_effect_receipt USING btree (erasure_operator_id, receipt_id);


--
-- Name: erasure_auth_provisioning_receipt_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_provisioning_receipt_0 ON public.auth_provisioning_receipt USING btree (account_id, idempotency_key);


--
-- Name: erasure_auth_provisioning_receipt_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_provisioning_receipt_1 ON public.auth_provisioning_receipt USING btree (owner_id, idempotency_key);


--
-- Name: erasure_auth_provisioning_receipt_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_provisioning_receipt_2 ON public.auth_provisioning_receipt USING btree (credential_id, idempotency_key);


--
-- Name: erasure_auth_recent_oidc_session_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_recent_oidc_session_0 ON public.auth_recent_oidc_session USING btree (account_id, session_id);


--
-- Name: erasure_auth_recent_oidc_session_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_recent_oidc_session_1 ON public.auth_recent_oidc_session USING btree (erasure_client_id, session_id);


--
-- Name: erasure_auth_recent_oidc_session_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_recent_oidc_session_2 ON public.auth_recent_oidc_session USING btree (erasure_human_id, session_id);


--
-- Name: erasure_auth_recent_oidc_session_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_recent_oidc_session_3 ON public.auth_recent_oidc_session USING btree (erasure_operator_id, session_id);


--
-- Name: erasure_auth_recovery_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_recovery_0 ON public.auth_recovery USING btree (account_id, proof_hash);


--
-- Name: erasure_auth_recovery_establishment_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_recovery_establishment_0 ON public.auth_recovery_establishment USING btree (account_id, reference);


--
-- Name: erasure_auth_recovery_establishment_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_recovery_establishment_1 ON public.auth_recovery_establishment USING btree (receipt_id, reference);


--
-- Name: erasure_auth_recovery_establishment_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_recovery_establishment_2 ON public.auth_recovery_establishment USING btree (erasure_client_id, reference);


--
-- Name: erasure_auth_recovery_establishment_source_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_recovery_establishment_source_client ON public.auth_recovery_establishment USING btree (erasure_source_client_id, reference);


--
-- Name: erasure_auth_registration_stage_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_registration_stage_0 ON public.auth_registration_stage USING btree (account_id, registration_id);


--
-- Name: erasure_auth_registration_stage_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_registration_stage_1 ON public.auth_registration_stage USING btree (erasure_creator_id, registration_id);


--
-- Name: erasure_auth_registration_stage_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_registration_stage_2 ON public.auth_registration_stage USING btree (erasure_operator_id, registration_id);


--
-- Name: erasure_auth_session_opening_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_session_opening_0 ON public.auth_session_opening USING btree (subject_account_id, session_id);


--
-- Name: erasure_auth_session_opening_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_session_opening_1 ON public.auth_session_opening USING btree (acting_human_id, session_id);


--
-- Name: erasure_auth_session_opening_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_session_opening_2 ON public.auth_session_opening USING btree (operator_account_id, session_id);


--
-- Name: erasure_auth_session_opening_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_auth_session_opening_3 ON public.auth_session_opening USING btree (erasure_client_id, session_id);


--
-- Name: erasure_establishment_human; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_establishment_human ON public.auth_recovery_establishment USING btree (erasure_human_id, reference);


--
-- Name: erasure_establishment_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_establishment_operator ON public.auth_recovery_establishment USING btree (erasure_operator_id, reference);


--
-- Name: erasure_oauthaccesstoken_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthaccesstoken_0 ON public."oauthAccessToken" USING btree ("userId", id);


--
-- Name: erasure_oauthaccesstoken_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthaccesstoken_1 ON public."oauthAccessToken" USING btree ("clientId", id);


--
-- Name: erasure_oauthaccesstoken_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthaccesstoken_2 ON public."oauthAccessToken" USING btree ("sessionId", id);


--
-- Name: erasure_oauthaccesstoken_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthaccesstoken_3 ON public."oauthAccessToken" USING btree ("refreshId", id);


--
-- Name: erasure_oauthaccesstoken_4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthaccesstoken_4 ON public."oauthAccessToken" USING btree ("authorizationCodeId", id);


--
-- Name: erasure_oauthaccesstoken_5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthaccesstoken_5 ON public."oauthAccessToken" USING btree (erasure_human_id, id);


--
-- Name: erasure_oauthaccesstoken_6; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthaccesstoken_6 ON public."oauthAccessToken" USING btree (erasure_operator_id, id);


--
-- Name: erasure_oauthaccesstoken_source_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthaccesstoken_source_client ON public."oauthAccessToken" USING btree (erasure_source_client_id, id);


--
-- Name: erasure_oauthclientassertion_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthclientassertion_0 ON public."oauthClientAssertion" USING btree (erasure_client_id, id);


--
-- Name: erasure_oauthclientresource_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthclientresource_0 ON public."oauthClientResource" USING btree ("clientId", id);


--
-- Name: erasure_oauthrefreshfamily_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshfamily_0 ON public."oauthRefreshFamily" USING btree ("clientId", id);


--
-- Name: erasure_oauthrefreshfamily_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshfamily_1 ON public."oauthRefreshFamily" USING btree (erasure_account_id, id);


--
-- Name: erasure_oauthrefreshfamily_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshfamily_2 ON public."oauthRefreshFamily" USING btree (erasure_human_id, id);


--
-- Name: erasure_oauthrefreshfamily_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshfamily_3 ON public."oauthRefreshFamily" USING btree (erasure_operator_id, id);


--
-- Name: erasure_oauthrefreshfamily_source_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshfamily_source_client ON public."oauthRefreshFamily" USING btree (erasure_source_client_id, id);


--
-- Name: erasure_oauthrefreshtoken_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshtoken_0 ON public."oauthRefreshToken" USING btree ("userId", id);


--
-- Name: erasure_oauthrefreshtoken_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshtoken_1 ON public."oauthRefreshToken" USING btree ("clientId", id);


--
-- Name: erasure_oauthrefreshtoken_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshtoken_2 ON public."oauthRefreshToken" USING btree ("sessionId", id);


--
-- Name: erasure_oauthrefreshtoken_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshtoken_3 ON public."oauthRefreshToken" USING btree ("authorizationCodeId", id);


--
-- Name: erasure_oauthrefreshtoken_4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshtoken_4 ON public."oauthRefreshToken" USING btree (erasure_human_id, id);


--
-- Name: erasure_oauthrefreshtoken_5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshtoken_5 ON public."oauthRefreshToken" USING btree (erasure_operator_id, id);


--
-- Name: erasure_oauthrefreshtoken_source_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_oauthrefreshtoken_source_client ON public."oauthRefreshToken" USING btree (erasure_source_client_id, id);


--
-- Name: erasure_provisioning_creator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_provisioning_creator ON public.auth_provisioning_receipt USING btree (erasure_creator_id, idempotency_key);


--
-- Name: erasure_provisioning_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_provisioning_operator ON public.auth_provisioning_receipt USING btree (erasure_operator_id, idempotency_key);


--
-- Name: erasure_request_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_actor ON public.auth_workflow_request USING btree (erasure_actor_id, workflow_id);


--
-- Name: erasure_request_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_client ON public.auth_workflow_request USING btree (erasure_client_id, workflow_id);


--
-- Name: erasure_request_human; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_human ON public.auth_workflow_request USING btree (erasure_human_id, workflow_id);


--
-- Name: erasure_request_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_member ON public.auth_workflow_request USING btree (erasure_member_id, workflow_id);


--
-- Name: erasure_request_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_operator ON public.auth_workflow_request USING btree (erasure_operator_id, workflow_id);


--
-- Name: erasure_request_previous_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_previous_operator ON public.auth_workflow_request USING btree (erasure_previous_operator_id, workflow_id);


--
-- Name: erasure_request_principal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_principal ON public.auth_workflow_request USING btree (erasure_principal_id, workflow_id);


--
-- Name: erasure_request_source_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_source_client ON public.auth_workflow_request USING btree (erasure_source_client_id, workflow_id);


--
-- Name: erasure_request_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_subject ON public.auth_workflow_request USING btree (erasure_subject_id, workflow_id);


--
-- Name: erasure_request_unknown_context; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_unknown_context ON public.auth_workflow_request USING btree (workflow_id) WHERE (request_party_version = 0);


--
-- Name: erasure_session_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_session_0 ON public.session USING btree ("userId", id);


--
-- Name: erasure_session_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_session_1 ON public.session USING btree ("clientId", id);


--
-- Name: erasure_session_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_session_2 ON public.session USING btree (erasure_human_id, id);


--
-- Name: erasure_session_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_session_3 ON public.session USING btree (erasure_operator_id, id);


--
-- Name: erasure_verification_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_verification_0 ON public.verification USING btree (erasure_account_id, id);


--
-- Name: erasure_verification_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_verification_1 ON public.verification USING btree (erasure_client_id, id);


--
-- Name: erasure_verification_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_verification_2 ON public.verification USING btree (erasure_session_id, id);


--
-- Name: erasure_verification_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_verification_3 ON public.verification USING btree (erasure_human_id, id);


--
-- Name: erasure_verification_4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_verification_4 ON public.verification USING btree (erasure_operator_id, id);


--
-- Name: erasure_verification_source_client; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_verification_source_client ON public.verification USING btree (erasure_source_client_id, id);


--
-- Name: native_role_account_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_account_pending ON public.account USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_attempt_account_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_attempt_account_pending ON public.auth_attempt_account USING btree (account_id, key) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_barrier_proof_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_barrier_proof_0 ON public.auth_barrier_proof USING btree (erasure_client_owner_id, reference);


--
-- Name: native_role_auth_barrier_proof_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_barrier_proof_1 ON public.auth_barrier_proof USING btree (erasure_source_client_owner_id, reference);


--
-- Name: native_role_auth_barrier_proof_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_barrier_proof_pending ON public.auth_barrier_proof USING btree (reference) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_client_coverage_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_coverage_0 ON public.auth_client_coverage USING btree (erasure_client_owner_id, client_id);


--
-- Name: native_role_auth_client_coverage_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_coverage_1 ON public.auth_client_coverage USING btree (erasure_source_client_owner_id, client_id);


--
-- Name: native_role_auth_client_coverage_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_coverage_pending ON public.auth_client_coverage USING btree (client_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_client_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_pending ON public.auth_client USING btree (client_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_client_reduction_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_reduction_0 ON public.auth_client_reduction USING btree (erasure_client_owner_id, client_id);


--
-- Name: native_role_auth_client_reduction_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_reduction_1 ON public.auth_client_reduction USING btree (erasure_source_client_owner_id, client_id);


--
-- Name: native_role_auth_client_reduction_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_reduction_pending ON public.auth_client_reduction USING btree (client_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_client_reduction_progress_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_reduction_progress_0 ON public.auth_client_reduction_progress USING btree (erasure_client_owner_id, operation_id);


--
-- Name: native_role_auth_client_reduction_progress_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_reduction_progress_1 ON public.auth_client_reduction_progress USING btree (erasure_source_client_owner_id, operation_id);


--
-- Name: native_role_auth_client_reduction_progress_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_client_reduction_progress_pending ON public.auth_client_reduction_progress USING btree (operation_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_consent_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_consent_0 ON public.auth_consent USING btree (erasure_client_owner_id, id);


--
-- Name: native_role_auth_consent_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_consent_1 ON public.auth_consent USING btree (erasure_source_client_owner_id, id);


--
-- Name: native_role_auth_consent_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_consent_pending ON public.auth_consent USING btree (account_id, client_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_effect_receipt_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_effect_receipt_0 ON public.auth_effect_receipt USING btree (erasure_client_owner_id, receipt_id);


--
-- Name: native_role_auth_effect_receipt_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_effect_receipt_1 ON public.auth_effect_receipt USING btree (erasure_source_client_owner_id, receipt_id);


--
-- Name: native_role_auth_effect_receipt_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_effect_receipt_pending ON public.auth_effect_receipt USING btree (receipt_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_key_assertion_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_key_assertion_pending ON public.auth_key_assertion USING btree (account_id, jti) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_provisioning_receipt_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_provisioning_receipt_0 ON public.auth_provisioning_receipt USING btree (erasure_delegate_id, idempotency_key);


--
-- Name: native_role_auth_provisioning_receipt_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_provisioning_receipt_1 ON public.auth_provisioning_receipt USING btree (erasure_initiator_id, idempotency_key);


--
-- Name: native_role_auth_provisioning_receipt_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_provisioning_receipt_pending ON public.auth_provisioning_receipt USING btree (idempotency_key) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_public_key_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_public_key_pending ON public.auth_public_key USING btree (account_id, kid) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_recent_oidc_session_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_recent_oidc_session_0 ON public.auth_recent_oidc_session USING btree (erasure_client_owner_id, session_id);


--
-- Name: native_role_auth_recent_oidc_session_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_recent_oidc_session_1 ON public.auth_recent_oidc_session USING btree (erasure_source_client_owner_id, session_id);


--
-- Name: native_role_auth_recent_oidc_session_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_recent_oidc_session_pending ON public.auth_recent_oidc_session USING btree (session_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_recovery_copy_source_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_recovery_copy_source_pending ON public.auth_recovery_copy_source USING btree (delivery_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_recovery_establishment_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_recovery_establishment_0 ON public.auth_recovery_establishment USING btree (erasure_client_owner_id, reference);


--
-- Name: native_role_auth_recovery_establishment_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_recovery_establishment_1 ON public.auth_recovery_establishment USING btree (erasure_source_client_owner_id, reference);


--
-- Name: native_role_auth_recovery_establishment_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_recovery_establishment_pending ON public.auth_recovery_establishment USING btree (reference) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_recovery_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_recovery_pending ON public.auth_recovery USING btree (proof_hash) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_registration_stage_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_registration_stage_0 ON public.auth_registration_stage USING btree (erasure_delegate_id, registration_id);


--
-- Name: native_role_auth_registration_stage_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_registration_stage_1 ON public.auth_registration_stage USING btree (erasure_initiator_id, registration_id);


--
-- Name: native_role_auth_registration_stage_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_registration_stage_pending ON public.auth_registration_stage USING btree (registration_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_session_opening_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_session_opening_0 ON public.auth_session_opening USING btree (erasure_client_owner_id, session_id);


--
-- Name: native_role_auth_session_opening_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_session_opening_1 ON public.auth_session_opening USING btree (erasure_source_client_owner_id, session_id);


--
-- Name: native_role_auth_session_opening_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_session_opening_pending ON public.auth_session_opening USING btree (session_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_auth_workflow_request_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_workflow_request_0 ON public.auth_workflow_request USING btree (erasure_client_owner_id, workflow_id);


--
-- Name: native_role_auth_workflow_request_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_workflow_request_1 ON public.auth_workflow_request USING btree (erasure_source_client_owner_id, workflow_id);


--
-- Name: native_role_auth_workflow_request_2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_workflow_request_2 ON public.auth_workflow_request USING btree (erasure_delegate_id, workflow_id);


--
-- Name: native_role_auth_workflow_request_3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_workflow_request_3 ON public.auth_workflow_request USING btree (erasure_initiator_id, workflow_id);


--
-- Name: native_role_auth_workflow_request_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_auth_workflow_request_pending ON public.auth_workflow_request USING btree (workflow_id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_oauthaccesstoken_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthaccesstoken_0 ON public."oauthAccessToken" USING btree (erasure_client_owner_id, id);


--
-- Name: native_role_oauthaccesstoken_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthaccesstoken_1 ON public."oauthAccessToken" USING btree (erasure_source_client_owner_id, id);


--
-- Name: native_role_oauthaccesstoken_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthaccesstoken_pending ON public."oauthAccessToken" USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_oauthclientassertion_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthclientassertion_0 ON public."oauthClientAssertion" USING btree (erasure_client_owner_id, id);


--
-- Name: native_role_oauthclientassertion_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthclientassertion_1 ON public."oauthClientAssertion" USING btree (erasure_source_client_owner_id, id);


--
-- Name: native_role_oauthclientassertion_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthclientassertion_pending ON public."oauthClientAssertion" USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_oauthclientresource_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthclientresource_0 ON public."oauthClientResource" USING btree (erasure_client_owner_id, id);


--
-- Name: native_role_oauthclientresource_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthclientresource_1 ON public."oauthClientResource" USING btree (erasure_source_client_owner_id, id);


--
-- Name: native_role_oauthclientresource_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthclientresource_pending ON public."oauthClientResource" USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_oauthrefreshfamily_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthrefreshfamily_0 ON public."oauthRefreshFamily" USING btree (erasure_client_owner_id, id);


--
-- Name: native_role_oauthrefreshfamily_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthrefreshfamily_1 ON public."oauthRefreshFamily" USING btree (erasure_source_client_owner_id, id);


--
-- Name: native_role_oauthrefreshfamily_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthrefreshfamily_pending ON public."oauthRefreshFamily" USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_oauthrefreshtoken_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthrefreshtoken_0 ON public."oauthRefreshToken" USING btree (erasure_client_owner_id, id);


--
-- Name: native_role_oauthrefreshtoken_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthrefreshtoken_1 ON public."oauthRefreshToken" USING btree (erasure_source_client_owner_id, id);


--
-- Name: native_role_oauthrefreshtoken_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_oauthrefreshtoken_pending ON public."oauthRefreshToken" USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_passkey_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_passkey_pending ON public.passkey USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_session_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_session_0 ON public.session USING btree (erasure_client_owner_id, id);


--
-- Name: native_role_session_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_session_1 ON public.session USING btree (erasure_source_client_owner_id, id);


--
-- Name: native_role_session_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_session_pending ON public.session USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_user_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_user_pending ON public."user" USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: native_role_verification_0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_verification_0 ON public.verification USING btree (erasure_client_owner_id, id);


--
-- Name: native_role_verification_1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_verification_1 ON public.verification USING btree (erasure_source_client_owner_id, id);


--
-- Name: native_role_verification_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX native_role_verification_pending ON public.verification USING btree (id) WHERE (erasure_role_version = 0);


--
-- Name: oauthAccessToken_authorizationCodeId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON public."oauthAccessToken" USING btree ("authorizationCodeId");


--
-- Name: oauthAccessToken_clientId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_clientId_idx" ON public."oauthAccessToken" USING btree ("clientId");


--
-- Name: oauthAccessToken_refreshId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_refreshId_idx" ON public."oauthAccessToken" USING btree ("refreshId");


--
-- Name: oauthAccessToken_sessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_sessionId_idx" ON public."oauthAccessToken" USING btree ("sessionId");


--
-- Name: oauthAccessToken_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthAccessToken_userId_idx" ON public."oauthAccessToken" USING btree ("userId");


--
-- Name: oauthClientResource_clientId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthClientResource_clientId_idx" ON public."oauthClientResource" USING btree ("clientId");


--
-- Name: oauthClientResource_clientId_resourceId_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON public."oauthClientResource" USING btree ("clientId", "resourceId");


--
-- Name: oauthClientResource_resourceId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthClientResource_resourceId_idx" ON public."oauthClientResource" USING btree ("resourceId");


--
-- Name: oauthRefreshFamily_expiresAt_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthRefreshFamily_expiresAt_idx" ON public."oauthRefreshFamily" USING btree ("expiresAt");


--
-- Name: oauthRefreshToken_authorizationCodeId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON public."oauthRefreshToken" USING btree ("authorizationCodeId");


--
-- Name: oauthRefreshToken_clientId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthRefreshToken_clientId_idx" ON public."oauthRefreshToken" USING btree ("clientId");


--
-- Name: oauthRefreshToken_sessionId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthRefreshToken_sessionId_idx" ON public."oauthRefreshToken" USING btree ("sessionId");


--
-- Name: oauthRefreshToken_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "oauthRefreshToken_userId_idx" ON public."oauthRefreshToken" USING btree ("userId");


--
-- Name: oauth_access_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_access_expiry ON public."oauthAccessToken" USING btree ("expiresAt", id);


--
-- Name: oauth_assertion_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_assertion_expiry ON public."oauthClientAssertion" USING btree ("expiresAt", id);


--
-- Name: oauth_refresh_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_refresh_expiry ON public."oauthRefreshToken" USING btree ("expiresAt", id);


--
-- Name: passkey_credentialid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX passkey_credentialid_idx ON public.passkey USING btree ("credentialID");


--
-- Name: passkey_userid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX passkey_userid_idx ON public.passkey USING btree ("userId", id);


--
-- Name: recovery_copy_client_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_copy_client_owner ON public.auth_recovery_copy_source USING btree (erasure_client_owner_id, delivery_id);


--
-- Name: recovery_copy_human; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_copy_human ON public.auth_recovery_copy_source USING btree (erasure_human_id, delivery_id);


--
-- Name: recovery_copy_operator; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_copy_operator ON public.auth_recovery_copy_source USING btree (erasure_operator_id, delivery_id);


--
-- Name: recovery_copy_source_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_copy_source_owner ON public.auth_recovery_copy_source USING btree (erasure_source_client_owner_id, delivery_id);


--
-- Name: recovery_copy_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recovery_copy_subject ON public.auth_recovery_copy_source USING btree (account_id, delivery_id);


--
-- Name: session_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_expiry ON public.session USING btree ("expiresAt", id);


--
-- Name: session_owner_oldest; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_owner_oldest ON public.session USING btree ("userId", "createdAt", id);


--
-- Name: session_upgrade_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_upgrade_owner ON public."user" USING btree (id) WHERE (NOT sessions_bounded);


--
-- Name: session_userId_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "session_userId_idx" ON public.session USING btree ("userId");


--
-- Name: verification_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_expiry_idx ON public.verification USING btree ("expiresAt", id);


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_identifier_idx ON public.verification USING btree (identifier);


--
-- Name: verification_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX verification_latest_idx ON public.verification USING btree (identifier, "createdAt" DESC, id DESC);


--
-- Name: auth_provisioning_receipt a_creation_parties; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a_creation_parties BEFORE INSERT OR UPDATE ON public.auth_provisioning_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_creation_parties_guard();


--
-- Name: auth_registration_stage a_creation_parties; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER a_creation_parties BEFORE INSERT OR UPDATE ON public.auth_registration_stage FOR EACH ROW EXECUTE FUNCTION public.auth_creation_parties_guard();


--
-- Name: auth_native_consumer_proof aa_native_proof_insert_lock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER aa_native_proof_insert_lock BEFORE INSERT ON public.auth_native_consumer_proof FOR EACH ROW EXECUTE FUNCTION public.auth_native_registration_proof_insert_lock();


--
-- Name: auth_provisioning_receipt aa_native_terminal_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER aa_native_terminal_fence BEFORE INSERT OR UPDATE ON public.auth_provisioning_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_native_registration_producer_fence();


--
-- Name: auth_registration_stage aa_native_terminal_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER aa_native_terminal_fence BEFORE INSERT ON public.auth_registration_stage FOR EACH ROW EXECUTE FUNCTION public.auth_native_registration_producer_fence();


--
-- Name: auth_workflow_request aa_native_terminal_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER aa_native_terminal_fence BEFORE INSERT OR UPDATE ON public.auth_workflow_request FOR EACH ROW EXECUTE FUNCTION public.auth_native_registration_producer_fence();


--
-- Name: auth_barrier_proof auth_barrier_proof_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_barrier_proof_immutable BEFORE UPDATE ON public.auth_barrier_proof FOR EACH ROW EXECUTE FUNCTION public.auth_barrier_proof_immutable();


--
-- Name: auth_consent auth_consent_cursor_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_consent_cursor_version BEFORE INSERT OR DELETE OR UPDATE ON public.auth_consent FOR EACH ROW EXECUTE FUNCTION public.auth_require_cursor_cutover();


--
-- Name: auth_consent auth_consent_revision; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_consent_revision BEFORE UPDATE ON public.auth_consent FOR EACH ROW EXECUTE FUNCTION public.auth_consent_revision();


--
-- Name: auth_copy_work auth_copy_native_fence_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_copy_native_fence_immutable BEFORE DELETE OR UPDATE ON public.auth_copy_work FOR EACH ROW EXECUTE FUNCTION public.auth_copy_native_fence_immutable();


--
-- Name: auth_copy_work auth_copy_result_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_copy_result_immutable BEFORE UPDATE ON public.auth_copy_work FOR EACH ROW EXECUTE FUNCTION public.auth_copy_result_immutable();


--
-- Name: auth_copy_role auth_copy_role_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_copy_role_guard BEFORE DELETE OR UPDATE ON public.auth_copy_role FOR EACH ROW EXECUTE FUNCTION public.auth_copy_role_guard();


--
-- Name: auth_client_coverage auth_coverage_cursor_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_coverage_cursor_version BEFORE INSERT OR DELETE OR UPDATE ON public.auth_client_coverage FOR EACH ROW EXECUTE FUNCTION public.auth_require_cursor_cutover();


--
-- Name: auth_effect_receipt auth_credential_stage_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_credential_stage_immutable BEFORE UPDATE ON public.auth_effect_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_credential_stage_immutable();


--
-- Name: auth_erasure auth_erasure_proof_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_erasure_proof_immutable BEFORE DELETE OR UPDATE ON public.auth_erasure FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_proof_immutable();


--
-- Name: auth_client_coverage auth_kind_client_coverage_writer_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_kind_client_coverage_writer_guard BEFORE INSERT OR DELETE OR UPDATE ON public.auth_client_coverage FOR EACH ROW EXECUTE FUNCTION public.auth_kind_consent_writer_guard();


--
-- Name: auth_client_reduction auth_kind_client_reduction_writer_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_kind_client_reduction_writer_guard BEFORE INSERT OR DELETE ON public.auth_client_reduction FOR EACH ROW EXECUTE FUNCTION public.auth_kind_consent_writer_guard();


--
-- Name: auth_client auth_kind_client_writer_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_kind_client_writer_guard BEFORE DELETE OR UPDATE ON public.auth_client FOR EACH ROW EXECUTE FUNCTION public.auth_kind_consent_writer_guard();


--
-- Name: auth_kind_consent_dependency auth_kind_consent_dependency_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_kind_consent_dependency_guard BEFORE INSERT OR DELETE OR UPDATE ON public.auth_kind_consent_dependency FOR EACH ROW EXECUTE FUNCTION public.auth_kind_consent_dependency_guard();


--
-- Name: auth_kind_consent_transition auth_kind_consent_transition_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_kind_consent_transition_guard BEFORE DELETE OR UPDATE ON public.auth_kind_consent_transition FOR EACH ROW EXECUTE FUNCTION public.auth_kind_consent_transition_guard();


--
-- Name: auth_consent auth_kind_consent_writer_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_kind_consent_writer_guard BEFORE INSERT OR DELETE OR UPDATE ON public.auth_consent FOR EACH ROW EXECUTE FUNCTION public.auth_kind_consent_writer_guard();


--
-- Name: auth_native_consumer_proof auth_native_consumer_proof_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_consumer_proof_immutable BEFORE DELETE OR UPDATE ON public.auth_native_consumer_proof FOR EACH ROW EXECUTE FUNCTION public.auth_native_consumer_proof_minimize_guard();


--
-- Name: auth_effect_receipt auth_native_credential_terminal_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_credential_terminal_fence BEFORE INSERT OR UPDATE ON public.auth_effect_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_native_credential_terminal_fence();


--
-- Name: auth_native_credential_terminal auth_native_credential_terminal_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_credential_terminal_immutable BEFORE DELETE OR UPDATE ON public.auth_native_credential_terminal FOR EACH ROW EXECUTE FUNCTION public.auth_native_credential_terminal_immutable();


--
-- Name: auth_copy_coverage auth_native_phase_coverage_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_phase_coverage_guard BEFORE INSERT OR UPDATE ON public.auth_copy_coverage FOR EACH ROW EXECUTE FUNCTION public.auth_native_phase_coverage_guard();


--
-- Name: auth_erasure auth_native_phase_cursor_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_phase_cursor_guard BEFORE INSERT OR UPDATE ON public.auth_erasure FOR EACH ROW EXECUTE FUNCTION public.auth_native_phase_cursor_guard();


--
-- Name: auth_provisioning_receipt auth_native_phase_producer_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_phase_producer_guard BEFORE INSERT OR DELETE OR UPDATE ON public.auth_provisioning_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_native_phase_producer_guard();


--
-- Name: auth_registration_stage auth_native_phase_producer_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_phase_producer_guard BEFORE INSERT OR DELETE OR UPDATE ON public.auth_registration_stage FOR EACH ROW EXECUTE FUNCTION public.auth_native_phase_producer_guard();


--
-- Name: auth_workflow_request auth_native_phase_producer_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_phase_producer_guard BEFORE INSERT OR DELETE OR UPDATE ON public.auth_workflow_request FOR EACH ROW EXECUTE FUNCTION public.auth_native_phase_producer_guard();


--
-- Name: auth_erasure auth_native_phase_upgrade_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_phase_upgrade_immutable BEFORE UPDATE ON public.auth_erasure FOR EACH ROW EXECUTE FUNCTION public.auth_native_phase_upgrade_immutable();


--
-- Name: auth_registration_stage auth_native_registration_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_registration_identity BEFORE UPDATE ON public.auth_registration_stage FOR EACH ROW EXECUTE FUNCTION public.auth_native_registration_identity();


--
-- Name: passkey auth_passkey_used; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_passkey_used BEFORE UPDATE OF counter ON public.passkey FOR EACH ROW EXECUTE FUNCTION public.auth_passkey_used();


--
-- Name: auth_provisioning_receipt auth_provisioning_receipt_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_provisioning_receipt_immutable BEFORE UPDATE ON public.auth_provisioning_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_provisioning_receipt_immutable();


--
-- Name: auth_receiving_copy auth_receiving_copy_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_receiving_copy_immutable BEFORE DELETE OR UPDATE ON public.auth_receiving_copy FOR EACH ROW EXECUTE FUNCTION public.auth_receiving_copy_immutable();


--
-- Name: auth_receiving_work auth_receiving_work_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_receiving_work_guard BEFORE INSERT OR DELETE OR UPDATE ON public.auth_receiving_work FOR EACH ROW EXECUTE FUNCTION public.auth_receiving_work_guard();


--
-- Name: auth_client_reduction_progress auth_reduction_cursor_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_reduction_cursor_version BEFORE INSERT OR DELETE OR UPDATE ON public.auth_client_reduction_progress FOR EACH ROW EXECUTE FUNCTION public.auth_require_cursor_cutover();


--
-- Name: auth_restore_generation auth_restore_cut_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_restore_cut_immutable BEFORE UPDATE ON public.auth_restore_generation FOR EACH ROW EXECUTE FUNCTION public.auth_restore_cut_immutable();


--
-- Name: auth_restore_generation auth_restore_identity_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_restore_identity_immutable BEFORE DELETE OR UPDATE ON public.auth_restore_generation FOR EACH ROW EXECUTE FUNCTION public.auth_restore_identity_immutable();


--
-- Name: auth_restore_live_generation auth_restore_live_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_restore_live_immutable BEFORE DELETE OR UPDATE ON public.auth_restore_live_generation FOR EACH ROW EXECUTE FUNCTION public.auth_restore_live_immutable();


--
-- Name: auth_restore_live_partition auth_restore_live_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_restore_live_immutable BEFORE DELETE OR UPDATE ON public.auth_restore_live_partition FOR EACH ROW EXECUTE FUNCTION public.auth_restore_live_immutable();


--
-- Name: auth_restore_live_work auth_restore_live_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_restore_live_immutable BEFORE DELETE OR UPDATE ON public.auth_restore_live_work FOR EACH ROW EXECUTE FUNCTION public.auth_restore_live_immutable();


--
-- Name: auth_restore_replay auth_restore_obligation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_restore_obligation_immutable BEFORE UPDATE ON public.auth_restore_replay FOR EACH ROW EXECUTE FUNCTION public.auth_restore_obligation_immutable();


--
-- Name: auth_restore_replay auth_restore_replay_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_restore_replay_immutable BEFORE DELETE OR UPDATE ON public.auth_restore_replay FOR EACH ROW EXECUTE FUNCTION public.auth_restore_replay_immutable();


--
-- Name: auth_erasure auth_restore_source_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_restore_source_immutable BEFORE UPDATE ON public.auth_erasure FOR EACH ROW EXECUTE FUNCTION public.auth_restore_source_immutable();


--
-- Name: user auth_user_cursor_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_user_cursor_version BEFORE INSERT OR DELETE OR UPDATE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.auth_require_cursor_cutover();


--
-- Name: auth_client configuration_fields; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER configuration_fields BEFORE INSERT OR UPDATE ON public.auth_client FOR EACH ROW EXECUTE FUNCTION public.auth_configuration_client_guard();


--
-- Name: oauthClientResource configuration_fields; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER configuration_fields BEFORE INSERT OR UPDATE ON public."oauthClientResource" FOR EACH ROW EXECUTE FUNCTION public.auth_configuration_link_guard();


--
-- Name: oauthResource configuration_fields; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER configuration_fields BEFORE INSERT OR UPDATE ON public."oauthResource" FOR EACH ROW EXECUTE FUNCTION public.auth_configuration_resource_guard();


--
-- Name: auth_barrier_proof erasure_attribution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_attribution BEFORE INSERT ON public.auth_barrier_proof FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_proof_roles();


--
-- Name: auth_recent_oidc_session erasure_attribution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_attribution BEFORE INSERT ON public.auth_recent_oidc_session FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_recent_roles();


--
-- Name: auth_recovery_establishment erasure_attribution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_attribution BEFORE INSERT ON public.auth_recovery_establishment FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_establishment_roles();


--
-- Name: auth_session_opening erasure_attribution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_attribution BEFORE INSERT ON public.auth_session_opening FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_opening_roles();


--
-- Name: oauthAccessToken erasure_attribution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_attribution BEFORE INSERT ON public."oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_token_roles();


--
-- Name: oauthRefreshToken erasure_attribution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_attribution BEFORE INSERT ON public."oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_token_roles();


--
-- Name: session erasure_attribution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_attribution BEFORE INSERT ON public.session FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_session_roles();


--
-- Name: verification erasure_attribution; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_attribution BEFORE INSERT OR UPDATE ON public.verification FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_verification_roles();


--
-- Name: account erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.account FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_account();


--
-- Name: auth_attempt_account erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_attempt_account FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_attempt_account();


--
-- Name: auth_barrier_proof erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_barrier_proof FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_barrier_proof();


--
-- Name: auth_client erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_client FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_client();


--
-- Name: auth_client_coverage erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_client_coverage FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_client_coverage();


--
-- Name: auth_client_reduction erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_client_reduction FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_client_reduction();


--
-- Name: auth_client_reduction_progress erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_client_reduction_progress FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_client_reduction_progress();


--
-- Name: auth_consent erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_consent FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_consent();


--
-- Name: auth_effect_receipt erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_effect_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_effect_receipt();


--
-- Name: auth_key_assertion erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_key_assertion FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_key_assertion();


--
-- Name: auth_provisioning_receipt erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_provisioning_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_provisioning_receipt();


--
-- Name: auth_public_key erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_public_key FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_public_key();


--
-- Name: auth_recent_oidc_session erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_recent_oidc_session FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_recent_oidc_session();


--
-- Name: auth_recovery erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_recovery FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_recovery();


--
-- Name: auth_recovery_establishment erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_recovery_establishment FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_recovery_establishment();


--
-- Name: auth_registration_stage erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_registration_stage FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_registration_stage();


--
-- Name: auth_session_opening erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_session_opening FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_auth_session_opening();


--
-- Name: auth_workflow_request erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.auth_workflow_request FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_request();


--
-- Name: oauthAccessToken erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public."oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_oauthaccesstoken();


--
-- Name: oauthClientAssertion erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public."oauthClientAssertion" FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_oauthclientassertion();


--
-- Name: oauthClientResource erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public."oauthClientResource" FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_oauthclientresource();


--
-- Name: oauthRefreshFamily erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public."oauthRefreshFamily" FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_oauthrefreshfamily();


--
-- Name: oauthRefreshToken erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public."oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_oauthrefreshtoken();


--
-- Name: passkey erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.passkey FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_passkey();


--
-- Name: session erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.session FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_session();


--
-- Name: user erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_user();


--
-- Name: verification erasure_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_fence BEFORE INSERT OR UPDATE ON public.verification FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_guard_verification();


--
-- Name: auth_session_opening erasure_opening_session; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_opening_session AFTER INSERT ON public.auth_session_opening FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_opening_session();


--
-- Name: auth_client erasure_zero_children; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_zero_children BEFORE DELETE ON public.auth_client FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_client_empty();


--
-- Name: user erasure_zero_children; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER erasure_zero_children BEFORE DELETE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.auth_erasure_user_empty();


--
-- Name: auth_native_consumer_proof native_proof_minimize; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER native_proof_minimize AFTER INSERT ON public.auth_native_consumer_proof FOR EACH ROW EXECUTE FUNCTION public.auth_native_registration_proof_inserted();


--
-- Name: auth_provisioning_receipt native_proof_minimize; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER native_proof_minimize AFTER DELETE ON public.auth_provisioning_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_native_registration_reader_deleted();


--
-- Name: auth_registration_stage native_proof_minimize; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER native_proof_minimize AFTER DELETE ON public.auth_registration_stage FOR EACH ROW EXECUTE FUNCTION public.auth_native_registration_reader_deleted();


--
-- Name: auth_workflow_request native_proof_minimize; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER native_proof_minimize AFTER DELETE ON public.auth_workflow_request FOR EACH ROW EXECUTE FUNCTION public.auth_native_registration_reader_deleted();


--
-- Name: auth_recovery_copy_source recovery_copy_capture; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recovery_copy_capture BEFORE INSERT ON public.auth_recovery_copy_source FOR EACH ROW EXECUTE FUNCTION public.auth_recovery_copy_capture();


--
-- Name: auth_recovery_copy_source recovery_copy_progress; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER recovery_copy_progress BEFORE DELETE OR UPDATE ON public.auth_recovery_copy_source FOR EACH ROW EXECUTE FUNCTION public.auth_recovery_copy_progress();


--
-- Name: session session_capacity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER session_capacity BEFORE INSERT ON public.session FOR EACH ROW EXECUTE FUNCTION public.auth_session_insert();


--
-- Name: user session_erasure_barrier; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER session_erasure_barrier BEFORE DELETE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.auth_session_erasure_barrier();


--
-- Name: session session_identity; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER session_identity BEFORE UPDATE OF id, "userId" ON public.session FOR EACH ROW EXECUTE FUNCTION public.auth_session_identity();


--
-- Name: account zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.account FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_account();


--
-- Name: auth_attempt_account zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_attempt_account FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_attempt_account();


--
-- Name: auth_barrier_proof zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_barrier_proof FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_barrier_proof();


--
-- Name: auth_client zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_client FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_client();


--
-- Name: auth_client_coverage zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_client_coverage FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_client_coverage();


--
-- Name: auth_client_reduction zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_client_reduction FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_client_reduction();


--
-- Name: auth_client_reduction_progress zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_client_reduction_progress FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_client_reduction_progress();


--
-- Name: auth_consent zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_consent FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_consent();


--
-- Name: auth_effect_receipt zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_effect_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_effect_receipt();


--
-- Name: auth_key_assertion zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_key_assertion FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_key_assertion();


--
-- Name: auth_provisioning_receipt zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_provisioning_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_provisioning_receipt();


--
-- Name: auth_public_key zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_public_key FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_public_key();


--
-- Name: auth_recent_oidc_session zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_recent_oidc_session FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_recent_oidc_session();


--
-- Name: auth_recovery zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_recovery FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_recovery();


--
-- Name: auth_recovery_establishment zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_recovery_establishment FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_recovery_establishment();


--
-- Name: auth_registration_stage zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_registration_stage FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_registration_stage();


--
-- Name: auth_session_opening zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_session_opening FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_session_opening();


--
-- Name: auth_workflow_request zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.auth_workflow_request FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_auth_workflow_request();


--
-- Name: oauthAccessToken zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public."oauthAccessToken" FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_oauthaccesstoken();


--
-- Name: oauthClientAssertion zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public."oauthClientAssertion" FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_oauthclientassertion();


--
-- Name: oauthClientResource zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public."oauthClientResource" FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_oauthclientresource();


--
-- Name: oauthRefreshFamily zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public."oauthRefreshFamily" FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_oauthrefreshfamily();


--
-- Name: oauthRefreshToken zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public."oauthRefreshToken" FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_oauthrefreshtoken();


--
-- Name: passkey zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.passkey FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_passkey();


--
-- Name: session zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.session FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_session();


--
-- Name: user zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_user();


--
-- Name: verification zz_native_role; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_native_role BEFORE INSERT OR DELETE OR UPDATE ON public.verification FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_verification();


--
-- Name: oauthClientAssertion zz_native_role_finish; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER zz_native_role_finish AFTER INSERT ON public."oauthClientAssertion" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_finish_oauthclientassertion();


--
-- Name: verification zz_native_role_finish; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER zz_native_role_finish AFTER INSERT ON public.verification DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.auth_native_role_finish_verification();


--
-- Name: verification zz_recovery_copy_producer_cut; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER zz_recovery_copy_producer_cut AFTER INSERT ON public.verification DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.auth_recovery_copy_producer_cut();


--
-- Name: auth_workflow_request zzz_native_request_party_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zzz_native_request_party_version BEFORE INSERT ON public.auth_workflow_request FOR EACH ROW EXECUTE FUNCTION public.auth_native_request_party_version_guard();


--
-- Name: auth_workflow_request zzz_request_parties; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zzz_request_parties BEFORE INSERT OR UPDATE ON public.auth_workflow_request FOR EACH ROW EXECUTE FUNCTION public.auth_request_parties_guard();


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_barrier_proof auth_barrier_proof_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_barrier_proof
    ADD CONSTRAINT auth_barrier_proof_account_id_fkey FOREIGN KEY (account_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_client_coverage auth_client_coverage_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_coverage
    ADD CONSTRAINT auth_client_coverage_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.auth_client(client_id);


--
-- Name: auth_client_reduction auth_client_reduction_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction
    ADD CONSTRAINT auth_client_reduction_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.auth_client(client_id);


--
-- Name: auth_client_reduction_progress auth_client_reduction_progress_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client_reduction_progress
    ADD CONSTRAINT auth_client_reduction_progress_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.auth_client(client_id);


--
-- Name: auth_client auth_client_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_client
    ADD CONSTRAINT "auth_client_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_consent auth_consent_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_consent
    ADD CONSTRAINT auth_consent_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.auth_client(client_id) ON DELETE CASCADE;


--
-- Name: auth_copy_artifact auth_copy_artifact_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_copy_artifact
    ADD CONSTRAINT auth_copy_artifact_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.auth_copy_work(workflow_id);


--
-- Name: auth_copy_role auth_copy_role_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_copy_role
    ADD CONSTRAINT auth_copy_role_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.auth_copy_work(workflow_id);


--
-- Name: auth_copy_work auth_copy_work_parent_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_copy_work
    ADD CONSTRAINT auth_copy_work_parent_workflow_id_fkey FOREIGN KEY (parent_workflow_id) REFERENCES public.auth_copy_work(workflow_id);


--
-- Name: auth_erased_client auth_erased_client_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_erased_client
    ADD CONSTRAINT auth_erased_client_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.auth_erasure(id);


--
-- Name: auth_key_assertion auth_key_assertion_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_key_assertion
    ADD CONSTRAINT auth_key_assertion_account_id_fkey FOREIGN KEY (account_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_native_credential_terminal auth_native_credential_terminal_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_native_credential_terminal
    ADD CONSTRAINT auth_native_credential_terminal_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.auth_erasure(id);


--
-- Name: auth_provisioning_receipt auth_provisioning_receipt_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_provisioning_receipt
    ADD CONSTRAINT auth_provisioning_receipt_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.account(id) ON DELETE CASCADE;


--
-- Name: auth_provisioning_receipt auth_provisioning_receipt_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_provisioning_receipt
    ADD CONSTRAINT auth_provisioning_receipt_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_public_key auth_public_key_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_public_key
    ADD CONSTRAINT auth_public_key_account_id_fkey FOREIGN KEY (account_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_receiving_copy auth_receiving_copy_obligation_id_control_revision_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_receiving_copy
    ADD CONSTRAINT auth_receiving_copy_obligation_id_control_revision_fkey FOREIGN KEY (obligation_id, control_revision) REFERENCES public.auth_receiving_work(obligation_id, control_revision);


--
-- Name: auth_receiving_work auth_receiving_work_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_receiving_work
    ADD CONSTRAINT auth_receiving_work_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.auth_erasure(id);


--
-- Name: auth_recovery auth_recovery_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery
    ADD CONSTRAINT auth_recovery_account_id_fkey FOREIGN KEY (account_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: auth_recovery_establishment auth_recovery_establishment_receipt_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_establishment
    ADD CONSTRAINT auth_recovery_establishment_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES public.auth_effect_receipt(receipt_id);


--
-- Name: auth_recovery_establishment auth_recovery_establishment_reference_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recovery_establishment
    ADD CONSTRAINT auth_recovery_establishment_reference_fkey FOREIGN KEY (reference) REFERENCES public.auth_barrier_proof(reference) ON DELETE CASCADE;


--
-- Name: auth_restore_live_partition auth_restore_live_partition_generation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_live_partition
    ADD CONSTRAINT auth_restore_live_partition_generation_fkey FOREIGN KEY (generation) REFERENCES public.auth_restore_live_generation(generation);


--
-- Name: auth_restore_live_work auth_restore_live_work_generation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_live_work
    ADD CONSTRAINT auth_restore_live_work_generation_fkey FOREIGN KEY (generation) REFERENCES public.auth_restore_live_generation(generation);


--
-- Name: auth_restore_replay auth_restore_replay_generation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_replay
    ADD CONSTRAINT auth_restore_replay_generation_fkey FOREIGN KEY (generation) REFERENCES public.auth_restore_generation(generation);


--
-- Name: auth_restore_replay auth_restore_replay_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_replay
    ADD CONSTRAINT auth_restore_replay_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.auth_erasure(id);


--
-- Name: auth_restore_source_partition auth_restore_source_partition_generation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_restore_source_partition
    ADD CONSTRAINT auth_restore_source_partition_generation_fkey FOREIGN KEY (generation) REFERENCES public.auth_restore_generation(generation);


--
-- Name: auth_session_opening auth_session_opening_subject_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_session_opening
    ADD CONSTRAINT auth_session_opening_subject_account_id_fkey FOREIGN KEY (subject_account_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public.auth_client(client_id) ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_refreshId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES public."oauthRefreshToken"(id) ON DELETE CASCADE;


--
-- Name: oauthAccessToken oauthAccessToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthAccessToken"
    ADD CONSTRAINT "oauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauthClientResource oauthClientResource_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public.auth_client(client_id) ON DELETE CASCADE;


--
-- Name: oauthClientResource oauthClientResource_resourceId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthClientResource"
    ADD CONSTRAINT "oauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES public."oauthResource"(identifier) ON DELETE CASCADE;


--
-- Name: oauthRefreshToken oauthRefreshToken_clientId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES public.auth_client(client_id) ON DELETE CASCADE;


--
-- Name: oauthRefreshToken oauthRefreshToken_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."oauthRefreshToken"
    ADD CONSTRAINT "oauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: passkey passkey_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.passkey
    ADD CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: session session_client_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_client_fk FOREIGN KEY ("clientId") REFERENCES public.auth_client(client_id);


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

