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
  DELETE FROM public.auth_workflow_request WHERE workflow_id=OLD.workflow_uuid;
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
    OR EXISTS (SELECT 1 FROM auth_client_reduction_progress WHERE client_id=OLD.client_id) THEN
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
  IF NEW.erasure_session_id IS NOT NULL THEN
    SELECT "clientId",erasure_human_id,erasure_operator_id
      INTO NEW.erasure_source_client_id,NEW.erasure_human_id,NEW.erasure_operator_id
      FROM session WHERE id=NEW.erasure_session_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Auth source session missing' USING ERRCODE='55000'; END IF;
  END IF;
  RETURN NEW;
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
    CONSTRAINT password_owner CHECK ((("providerId" = 'credential'::text) AND ("accountId" = "userId")))
);


--
-- Name: auth_attempt_account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_attempt_account (
    account_id text NOT NULL,
    key text NOT NULL
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
    CONSTRAINT auth_barrier_proof_account_id_check CHECK (((length(account_id) >= 1) AND (length(account_id) <= 1024))),
    CONSTRAINT auth_barrier_proof_check CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:05:00'::interval)))),
    CONSTRAINT auth_barrier_proof_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
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
    erasure_fenced boolean DEFAULT false NOT NULL
);


--
-- Name: auth_client_coverage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client_coverage (
    client_id text NOT NULL,
    legacy_after_account text,
    ready boolean DEFAULT false NOT NULL,
    ready_after timestamp with time zone DEFAULT (CURRENT_TIMESTAMP + '00:05:00'::interval) NOT NULL,
    after_ordinal bigint DEFAULT 0 NOT NULL
);


--
-- Name: auth_client_reduction; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_client_reduction (
    client_id text NOT NULL,
    operation_id text NOT NULL,
    scopes text[] NOT NULL,
    first_party boolean NOT NULL
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
    completed_count integer DEFAULT 0 NOT NULL
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
    CONSTRAINT auth_credential_stage CHECK (((((operation_key IS NULL) AND (effect_reference IS NULL) AND (effect_digest IS NULL) AND (stage_version IS NULL) AND (stage_ciphertext IS NULL) AND (committed_result IS NULL) AND (committed_at IS NULL) AND (opening_receipt_id IS NULL)) OR ((operation_key IS NOT NULL) AND (effect_reference IS NOT NULL) AND (effect_digest ~ '^[a-f0-9]{64}$'::text) AND (stage_version = 1) AND (stage_ciphertext IS NOT NULL) AND (acting_human_id IS NOT NULL) AND (client_id IS NOT NULL) AND (scopes IS NOT NULL) AND (purpose = ANY (ARRAY['set-password'::text, 'remove-password'::text, 'add-key'::text, 'remove-key'::text, 'add-passkey'::text, 'remove-passkey'::text])) AND ((credential_row_id IS NULL) = (credential_row_version IS NULL)) AND (((committed_at IS NULL) AND (committed_result IS NULL) AND (opening_receipt_id IS NULL)) OR ((committed_at IS NOT NULL) AND (opening_receipt_id IS NOT NULL) AND (committed_result = jsonb_build_object('receiptId', receipt_id, 'replayed', false)))))) IS TRUE)),
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
    CONSTRAINT auth_erasure_after_key_check CHECK ((octet_length(after_key) <= 1024)),
    CONSTRAINT auth_erasure_barrier_check CHECK ((barrier >= 0)),
    CONSTRAINT auth_erasure_client_id_check CHECK ((octet_length(client_id) <= 1024)),
    CONSTRAINT auth_erasure_inventory_coverage_check CHECK ((inventory_coverage = ANY (ARRAY['unknown'::text, 'covered'::text]))),
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
    expires_at timestamp with time zone NOT NULL
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
    CONSTRAINT auth_provisioning_evidence_complete CHECK ((((registration_id IS NULL) AND (reservation_id IS NULL) AND (authn_epoch IS NULL) AND (expires_at IS NULL) AND (owner_id IS NULL) AND (credential_id IS NULL) AND (provisioning_kind IS NULL)) OR ((registration_id IS NOT NULL) AND (reservation_id IS NOT NULL) AND (authn_epoch IS NOT NULL) AND ((authn_epoch >= 1) AND (authn_epoch <= '9007199254740991'::bigint)) AND (expires_at IS NOT NULL) AND (owner_id IS NOT NULL) AND (owner_id = account_id) AND (credential_id IS NOT NULL) AND (provisioning_kind IS NOT NULL) AND (provisioning_kind = ANY (ARRAY['password'::text, 'credentialless'::text])))))
);


--
-- Name: auth_public_key; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_public_key (
    account_id text NOT NULL,
    kid text NOT NULL,
    public_jwk jsonb NOT NULL,
    CONSTRAINT auth_public_key_public_jwk_check CHECK ((((public_jwk ->> 'alg'::text) = 'ES256'::text) AND (NOT (public_jwk ? 'd'::text)) AND (NOT (public_jwk ? 'k'::text))))
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
    erasure_operator_id text
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
    CONSTRAINT auth_recovery_authn_epoch_check CHECK ((authn_epoch >= 0)),
    CONSTRAINT auth_recovery_consumption CHECK ((((consumed_operation IS NULL) AND (consumed_verification_id IS NULL) AND (consumed_at IS NULL)) OR ((consumed_operation IS NOT NULL) AND (consumed_verification_id IS NOT NULL) AND (consumed_at IS NOT NULL))))
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
    CONSTRAINT auth_recovery_establishment_authn_epoch_check CHECK ((authn_epoch > 0)),
    CONSTRAINT auth_recovery_establishment_credential_fingerprint_check CHECK ((credential_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT auth_recovery_establishment_effect_commitment_check CHECK ((effect_commitment ~ '^[0-9a-f]{64}$'::text))
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
    operator_reservation_id text
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
    erasure_client_id text
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
    erasure_stage_id text
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
    erasure_operator_id text
);


--
-- Name: oauthClientAssertion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthClientAssertion" (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    erasure_client_id text
);


--
-- Name: oauthClientResource; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."oauthClientResource" (
    id text NOT NULL,
    "clientId" text NOT NULL,
    "resourceId" text NOT NULL,
    metadata jsonb,
    "createdAt" timestamp with time zone
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
    erasure_operator_id text
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
    erasure_operator_id text
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
    metadata jsonb
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
    last_used_at timestamp with time zone
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
    CONSTRAINT session_authentication CHECK ((("authnEpoch" >= 0) AND ("authTime" >= 0) AND ("authMethods" = ANY (ARRAY['pwd'::text, 'pop'::text, 'private_key_jwt'::text, 'operator'::text]))))
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
    CONSTRAINT inert_profile CHECK (((name = ''::text) AND (image IS NULL)))
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
    erasure_operator_id text
);


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
-- Name: auth_recent_oidc_session auth_recent_oidc_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_recent_oidc_session
    ADD CONSTRAINT auth_recent_oidc_session_pkey PRIMARY KEY (session_id);


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
-- Name: auth_credential_operation; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_credential_operation ON public.auth_effect_receipt USING btree (account_id, operation_key) WHERE (operation_key IS NOT NULL);


--
-- Name: auth_credential_reference; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX auth_credential_reference ON public.auth_effect_receipt USING btree (effect_reference) WHERE (effect_reference IS NOT NULL);


--
-- Name: auth_erasure_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auth_erasure_pending ON public.auth_erasure USING btree (revision, id) WHERE (native_completed_at IS NULL);


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
-- Name: erasure_request_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX erasure_request_subject ON public.auth_workflow_request USING btree (erasure_subject_id, workflow_id);


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
-- Name: auth_client_coverage auth_coverage_cursor_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_coverage_cursor_version BEFORE INSERT OR DELETE OR UPDATE ON public.auth_client_coverage FOR EACH ROW EXECUTE FUNCTION public.auth_require_cursor_cutover();


--
-- Name: auth_effect_receipt auth_credential_stage_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_credential_stage_immutable BEFORE UPDATE ON public.auth_effect_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_credential_stage_immutable();


--
-- Name: auth_native_consumer_proof auth_native_consumer_proof_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_consumer_proof_immutable BEFORE DELETE OR UPDATE ON public.auth_native_consumer_proof FOR EACH ROW EXECUTE FUNCTION public.auth_native_credential_terminal_immutable();


--
-- Name: auth_effect_receipt auth_native_credential_terminal_fence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_credential_terminal_fence BEFORE INSERT OR UPDATE ON public.auth_effect_receipt FOR EACH ROW EXECUTE FUNCTION public.auth_native_credential_terminal_fence();


--
-- Name: auth_native_credential_terminal auth_native_credential_terminal_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_native_credential_terminal_immutable BEFORE DELETE OR UPDATE ON public.auth_native_credential_terminal FOR EACH ROW EXECUTE FUNCTION public.auth_native_credential_terminal_immutable();


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
-- Name: auth_client_reduction_progress auth_reduction_cursor_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_reduction_cursor_version BEFORE INSERT OR DELETE OR UPDATE ON public.auth_client_reduction_progress FOR EACH ROW EXECUTE FUNCTION public.auth_require_cursor_cutover();


--
-- Name: user auth_user_cursor_version; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auth_user_cursor_version BEFORE INSERT OR DELETE OR UPDATE ON public."user" FOR EACH ROW EXECUTE FUNCTION public.auth_require_cursor_cutover();


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

