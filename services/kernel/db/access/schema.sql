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
-- Name: access; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA access;


--
-- Name: advance_operator_relation(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.advance_operator_relation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF access.native_terminal_account_ready(OLD) AND NEW.operator_relation_version=0
     AND OLD.operator_account_id IS NULL AND NEW.operator_account_id IS NULL
     AND OLD.operator_reservation_id IS NULL AND NEW.operator_reservation_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.operator_account_id IS DISTINCT FROM OLD.operator_account_id
     OR NEW.operator_reservation_id IS DISTINCT FROM OLD.operator_reservation_id THEN
    NEW.operator_relation_version := OLD.operator_relation_version + 1;
  ELSIF NEW.operator_relation_version IS DISTINCT FROM OLD.operator_relation_version THEN
    RAISE EXCEPTION 'Operator relation version is command owned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: close_membership_authority(integer, uuid, uuid, timestamp with time zone, uuid); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.close_membership_authority(p_route integer, p_organization_id uuid, p_member_id uuid, p_at timestamp with time zone, p_transaction_id uuid) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  target record;
  changed integer := 0;
  overlapping CURSOR FOR
    SELECT m.valid
    FROM access.organization_member m
    WHERE m.route = p_route AND m.organization_id = p_organization_id
      AND m.member_account_id = p_member_id
      AND m.valid && tstzrange(p_at, NULL, '[)')
    -- Retain the native GiST traversal; all matching routes have distance zero.
    ORDER BY m.route <-> p_route
    FOR UPDATE;
BEGIN
  OPEN overlapping;
  LOOP
    FETCH overlapping INTO target;
    EXIT WHEN NOT FOUND;

    IF lower_inf(target.valid) OR lower(target.valid) < p_at THEN
      UPDATE access.organization_member
      SET valid = tstzrange(lower(target.valid), p_at,
                            CASE WHEN lower_inc(target.valid) THEN '[)' ELSE '()' END),
          transaction_id = p_transaction_id
      WHERE CURRENT OF overlapping;
    ELSE
      -- Including lower = T: delete rather than construct an empty range.
      DELETE FROM access.organization_member WHERE CURRENT OF overlapping;
    END IF;
    changed := changed + 1;
  END LOOP;
  CLOSE overlapping;
  RETURN changed;
END;
$$;


--
-- Name: committed_continuation_completion_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.committed_continuation_completion_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' AND access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Committed continuation completions are immutable';
END;
$$;


--
-- Name: committed_continuation_entries(jsonb, integer, integer, boolean); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.committed_continuation_entries(value jsonb, minimum integer, maximum integer, completed boolean) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) BETWEEN minimum AND maximum
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(value) AS elem
      WHERE jsonb_typeof(elem) <> 'object'
        OR (SELECT count(*) FROM jsonb_object_keys(elem) AS object_key) <> CASE WHEN completed THEN 5 ELSE 4 END
        OR COALESCE(elem->>'step', '') !~ '^[a-z][a-z0-9-]{0,63}$'
        OR COALESCE(length(elem->>'target'), 0) NOT BETWEEN 1 AND 128
        OR COALESCE(length(elem->>'key'), 0) NOT BETWEEN 1 AND 240
        OR COALESCE(elem->>'digest', '') !~ '^[0-9a-f]{64}$'
        OR (completed AND COALESCE(elem->>'receiptId', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        OR (NOT completed AND jsonb_exists(elem, 'receiptId'))
    );
$_$;


--
-- Name: committed_continuation_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.committed_continuation_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (to_jsonb(OLD) - 'expires_at' - 'completions') = (to_jsonb(NEW) - 'expires_at' - 'completions')
    AND (
      (OLD.expires_at = NEW.expires_at
        AND jsonb_array_length(NEW.completions) = jsonb_array_length(OLD.completions) + 1
        AND NEW.completions @> OLD.completions)
      OR (NEW.completions = OLD.completions AND NEW.expires_at > OLD.expires_at AND NEW.expires_at > OLD.created_at)
    )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Committed continuations are immutable';
END;
$$;


--
-- Name: erasure_entry_account(text, text); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.erasure_entry_account(step text, target text) RETURNS uuid
    LANGUAGE sql IMMUTABLE
    AS $$
 SELECT CASE
   WHEN step IN ('erase-auth-owner','revoke-auth-sessions','operator-responsibility-page','operator-unfence-page')
     THEN target::uuid
   WHEN step IN ('retire-operator','release-operator','fence','unfence') THEN split_part(target,':',1)::uuid
 END;
$$;


--
-- Name: erasure_requested_principal(text); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.erasure_requested_principal(value text) RETURNS uuid
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT CASE WHEN value ~ '^urn:rezics:request:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    THEN split_part(value, ':', 4)::uuid END;
$_$;


--
-- Name: guard_account_creation_time(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_account_creation_time() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NEW.created_at IS DISTINCT FROM OLD.created_at AND NOT (NEW.created_at IS NULL AND access.native_terminal_account_ready(OLD)) THEN
  RAISE EXCEPTION 'Account creation time is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;


--
-- Name: guard_account_identity(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_account_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.route IS DISTINCT FROM OLD.route THEN
    RAISE EXCEPTION 'Account ID, kind and route are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.minimum_authn_epoch < OLD.minimum_authn_epoch THEN
    RAISE EXCEPTION 'Authentication epoch floor cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_assignment_identity(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_assignment_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR (NEW.issued_valid IS NOT NULL AND NEW.issued_valid IS DISTINCT FROM NEW.valid) THEN
      RAISE EXCEPTION 'Assignment must begin with its original validity' USING ERRCODE = '23514';
    END IF;
    NEW.issued_valid := NEW.valid;
  ELSE
    IF ROW(NEW.route, NEW.principal_id, NEW.request_id, NEW.creator_principal_id, NEW.issued_valid, NEW.transaction_id)
       IS DISTINCT FROM
       ROW(OLD.route, OLD.principal_id, OLD.request_id, OLD.creator_principal_id, OLD.issued_valid, OLD.transaction_id)
       OR (OLD.creator_principal_id IS NOT NULL AND NEW.assigned_actor_id IS DISTINCT FROM OLD.assigned_actor_id)
       OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.valid) IS DISTINCT FROM ROW(OLD.revoked_at, OLD.valid))
       OR (OLD.creator_principal_id IS NOT NULL AND NEW.revoked_at IS NULL AND NEW.valid IS DISTINCT FROM OLD.valid)
       OR (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
           AND NEW.valid IS DISTINCT FROM OLD.valid * tstzrange(NULL, NEW.revoked_at, '[)')) THEN
      RAISE EXCEPTION 'Assignment identity and revocation are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_erasure(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Erasure records are permanent' USING ERRCODE = '23514';
  END IF;
  IF NEW.route IS DISTINCT FROM OLD.route OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.at IS DISTINCT FROM OLD.at
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'Erasure records cannot reopen or change identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_erasure_acknowledgement(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_erasure_acknowledgement() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  store text;
  resolved jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Erasure acknowledgements are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.route IS DISTINCT FROM OLD.route OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.participant IS DISTINCT FROM OLD.participant OR NEW.outcome IS DISTINCT FROM OLD.outcome
     OR NEW.retained IS DISTINCT FROM OLD.retained OR NOT (NEW.resolutions @> OLD.resolutions) THEN
    RAISE EXCEPTION 'Erasure acknowledgements are immutable' USING ERRCODE = '23514';
  END IF;
  FOR store, resolved IN SELECT key, value FROM jsonb_each(NEW.resolutions) LOOP
    IF jsonb_typeof(resolved) <> 'string' OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.retained) x
      WHERE x->>'store' = store AND (x->>'expiresAt')::timestamptz <= (resolved #>> '{}')::timestamptz
    ) THEN
      RAISE EXCEPTION 'Invalid retention resolution' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;


--
-- Name: guard_lifecycle_responsibility(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_lifecycle_responsibility() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ((NEW.operator_account_id IS DISTINCT FROM OLD.operator_account_id AND NEW.operator_account_id IS NOT NULL)
      OR (NEW.state = 'deleted' AND OLD.state <> 'deleted'))
     AND EXISTS (SELECT 1 FROM access.lifecycle_coordination
                 WHERE route = OLD.route AND account_id = OLD.account_id) THEN
    RAISE EXCEPTION 'Unresolved account responsibility' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_membership_inverse(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_membership_inverse() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM access.membership_inverse_terminal t
    WHERE t.route = OLD.route AND t.account_id = OLD.account_id
      AND t.kind = OLD.kind AND t.group_id = OLD.group_id
      AND t.reservation_id = OLD.reservation_id
      AND t.reservation_transaction_id = OLD.transaction_id
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    -- Rotation keeps the logical membership and cap slot, but retires only a
    -- reservation whose immutable authoritative terminal proof was verified.
    IF NEW.route = OLD.route AND NEW.account_id = OLD.account_id
      AND NEW.kind = OLD.kind AND NEW.group_id = OLD.group_id
      AND NEW.reservation_id <> OLD.reservation_id THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Membership inverse requires verified terminal compensation' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_membership_terminal(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_membership_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' AND access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Membership terminal proof is immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_native_continuation_delete(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_native_continuation_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF NOT access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD))
 OR EXISTS (SELECT 1 FROM access.committed_continuation_entry WHERE route=OLD.route AND continuation_id=OLD.continuation_id)
 OR EXISTS (SELECT 1 FROM access.committed_continuation_completion WHERE route=OLD.route AND continuation_id=OLD.continuation_id)
 OR EXISTS (SELECT 1 FROM access.operator_fence_page WHERE route=OLD.route AND continuation_id=OLD.continuation_id) THEN
  RAISE EXCEPTION 'Continuation erasure requires finished consumers and drained children' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END;
$$;


--
-- Name: guard_native_erasure_replay(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_native_erasure_replay() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 PERFORM 1 FROM access.committed_continuation c
   WHERE c.route=NEW.route AND c.continuation_id=NEW.continuation_id FOR KEY SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'Native continuation has been erased' USING ERRCODE='23514';
 END IF;
 IF EXISTS (SELECT 1 FROM access.erasure_native_consumed_child d
   WHERE d.route=NEW.route AND d.continuation_id=NEW.continuation_id
   AND d.artifact=CASE TG_TABLE_NAME WHEN 'committed_continuation_entry' THEN 'entry'
     WHEN 'committed_continuation_completion' THEN 'completion' ELSE 'page' END
   AND d.entry_key=CASE WHEN TG_TABLE_NAME='operator_fence_page'
     THEN sha256(convert_to(to_jsonb(NEW)->>'page_key','UTF8'))
     ELSE sha256(convert_to(concat_ws(':',to_jsonb(NEW)->>'step',to_jsonb(NEW)->>'key'),'UTF8')) END) THEN
  RAISE EXCEPTION 'Native continuation child is permanently consumed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;


--
-- Name: guard_retired_handle(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_retired_handle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.state = 'retired' THEN
    RAISE EXCEPTION 'Retired handles are permanent' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.state = 'retired' THEN
    IF TG_OP <> 'UPDATE' OR OLD.state <> 'reserved' OR OLD.hold_operation_id IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM access.erasure e WHERE e.account_id = OLD.account_id
        AND e.route = (get_byte(uuid_send(OLD.account_id),10)*256+get_byte(uuid_send(OLD.account_id),11)))
      OR EXISTS (SELECT 1 FROM access.lifecycle_handle_operation o WHERE o.account_id = OLD.account_id
        AND o.route = (get_byte(uuid_send(OLD.account_id),10)*256+get_byte(uuid_send(OLD.account_id),11))
        AND o.state = 'published') THEN
      RAISE EXCEPTION 'Handle erasure requires a permanent obligation and finished consumer' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM access.erasure e WHERE e.account_id = NEW.account_id
    AND e.route = (get_byte(uuid_send(NEW.account_id),10)*256+get_byte(uuid_send(NEW.account_id),11))) THEN
    -- The committed deletion's real native redirect consumer may finish. No new
    -- reservation, hold, ownership or revival can cross the permanent barrier.
    IF TG_OP <> 'UPDATE' OR OLD.account_id IS DISTINCT FROM NEW.account_id
      OR OLD.state <> 'active' OR NEW.state <> 'reserved' OR NEW.hold_operation_id IS NOT NULL THEN
      RAISE EXCEPTION 'Erased accounts cannot allocate handles' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: initialize_membership_inverse(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.initialize_membership_inverse() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Accounts born after the writer barrier have no historical memberships.
  NEW.membership_inverse_complete := true;
  RETURN NEW;
END;
$$;


--
-- Name: native_erasure_delete_ready(text, jsonb); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.native_erasure_delete_ready(store text, value jsonb) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE erased uuid; root access.committed_continuation;
BEGIN
 SELECT p.account_id INTO erased FROM access.erasure_native_progress p JOIN access.erasure e USING(route,account_id)
 WHERE p.progress_id::text=current_setting('rezics.erasure_progress',true);
 IF erased IS NULL OR value->>'erasure_row_id' IS DISTINCT FROM current_setting('rezics.erasure_row',true) THEN RETURN false; END IF;
 IF store='membership_inverse_terminal' THEN
  RETURN (erased=(value->>'account_id')::uuid OR erased=(value->>'group_id')::uuid)
   AND NOT EXISTS (SELECT 1 FROM access.membership_inverse m WHERE m.route=(value->>'route')::int
     AND m.account_id=(value->>'account_id')::uuid AND m.kind=value->>'kind' AND m.group_id=(value->>'group_id')::uuid
     AND m.reservation_id=(value->>'reservation_id')::uuid)
   AND NOT EXISTS (SELECT 1 FROM access.lifecycle_coordination c WHERE c.route=(value->>'route')::int
     AND c.account_id=(value->>'account_id')::uuid AND c.reservation_id=(value->>'reservation_id')::uuid);
 ELSIF store='lifecycle_membership_slot' THEN
  RETURN (value->>'terminal')::boolean AND (erased=(value->>'organization_id')::uuid OR erased=(value->>'member_account_id')::uuid);
 ELSIF store IN ('committed_continuation_entry','committed_continuation_completion','committed_continuation','operator_fence_page') THEN
  IF NOT EXISTS (SELECT 1 FROM access.erasure_continuation_role r WHERE r.route=(value->>'route')::int
    AND r.row_id=(value->>'erasure_row_id')::uuid AND r.account_id=erased
    AND r.artifact=CASE store WHEN 'committed_continuation' THEN 'root' WHEN 'committed_continuation_entry' THEN 'entry'
      WHEN 'committed_continuation_completion' THEN 'completion' ELSE 'page' END) THEN RETURN false; END IF;
  SELECT * INTO root FROM access.committed_continuation WHERE route=(value->>'route')::int
    AND continuation_id=(value->>'continuation_id')::uuid;
  RETURN root.allowlist @> '[{"step":"erase-auth-owner"}]'::jsonb
    AND EXISTS (SELECT 1 FROM access.auth_history_proof p JOIN access.erasure e USING(route,account_id)
      WHERE p.route=root.route AND p.account_id=root.account_id AND p.phase='native-consumed'
        AND p.continuation_id=root.continuation_id AND p.receipt_id=root.barrier_receipt_id AND p.version=e.version AND p.at=e.at)
    AND NOT EXISTS (SELECT 1 FROM access.lifecycle_handle_operation h
      WHERE h.route=root.route AND h.account_id=root.account_id AND h.state='published');
 END IF;
 RETURN false;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account (
    discovery_revision bigint DEFAULT 0 NOT NULL,
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    handle text COLLATE pg_catalog."C",
    display_name text,
    avatar_url text,
    biography text,
    state text DEFAULT 'pending'::text NOT NULL,
    operator_account_id uuid,
    controller_id uuid,
    birth_date date,
    content_preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    suspension_reason text,
    minimum_authn_epoch bigint DEFAULT 1 NOT NULL,
    transaction_id uuid NOT NULL,
    registration_id uuid,
    registration_expires_at timestamp with time zone,
    authn_fenced boolean DEFAULT false NOT NULL,
    fence_receipt_id uuid,
    operator_relation_version bigint DEFAULT 0 NOT NULL,
    operator_reservation_id uuid,
    membership_inverse_complete boolean DEFAULT false NOT NULL,
    handle_operation_id text,
    created_at timestamp with time zone DEFAULT statement_timestamp(),
    rate_tier text DEFAULT 'ordinary'::text NOT NULL,
    links jsonb DEFAULT '[]'::jsonb NOT NULL,
    avatar uuid,
    public_views jsonb DEFAULT '{"posts": true, "realms": false, "reviews": true, "collections": true}'::jsonb NOT NULL,
    speakers_listed boolean DEFAULT false NOT NULL,
    agent_verified boolean DEFAULT false NOT NULL,
    agent_subject_id uuid,
    agent_verification_receipt_id uuid,
    pending_agent_subject_id uuid,
    pending_agent_receipt_id uuid,
    public_changed_at timestamp with time zone DEFAULT statement_timestamp(),
    handle_change_times timestamp with time zone[] DEFAULT '{}'::timestamp with time zone[] NOT NULL,
    membership_time timestamp with time zone,
    CONSTRAINT account_agent_verification_check CHECK ((((pending_agent_subject_id IS NULL) = (pending_agent_receipt_id IS NULL)) AND ((agent_verified AND (agent_subject_id IS NOT NULL) AND (agent_verification_receipt_id IS NOT NULL) AND (pending_agent_subject_id IS NULL)) OR ((NOT agent_verified) AND (agent_subject_id IS NULL) AND (agent_verification_receipt_id IS NULL))))),
    CONSTRAINT account_avatar_route_check CHECK (((avatar IS NULL) OR (route = ((get_byte(uuid_send(avatar), 10) * 256) + get_byte(uuid_send(avatar), 11))))),
    CONSTRAINT account_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_check1 CHECK (((operator_account_id IS NULL) OR ((kind = 'actor'::text) AND (operator_account_id <> account_id)))),
    CONSTRAINT account_content_preferences_check CHECK ((jsonb_typeof(content_preferences) = 'object'::text)),
    CONSTRAINT account_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT account_handle_change_times_check CHECK ((cardinality(handle_change_times) <= 5)),
    CONSTRAINT account_handle_check CHECK ((handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT account_kind_check CHECK ((kind = ANY (ARRAY['actor'::text, 'organization'::text]))),
    CONSTRAINT account_links_check CHECK (((jsonb_typeof(links) = 'array'::text) AND (jsonb_array_length(links) <= 5))),
    CONSTRAINT account_live_timestamps CHECK (((state = 'deleted'::text) OR ((created_at IS NOT NULL) AND (public_changed_at IS NOT NULL)))),
    CONSTRAINT account_membership_time_check CHECK (isfinite(membership_time)),
    CONSTRAINT account_minimum_authn_epoch_check CHECK ((minimum_authn_epoch > 0)),
    CONSTRAINT account_operator_relation_version_check CHECK ((operator_relation_version >= 0)),
    CONSTRAINT account_public_views_check CHECK (((jsonb_typeof(public_views) = 'object'::text) AND (public_views ?& ARRAY['posts'::text, 'reviews'::text, 'collections'::text, 'realms'::text]) AND ((public_views - ARRAY['posts'::text, 'reviews'::text, 'collections'::text, 'realms'::text]) = '{}'::jsonb) AND (jsonb_typeof((public_views -> 'posts'::text)) = 'boolean'::text) AND (jsonb_typeof((public_views -> 'reviews'::text)) = 'boolean'::text) AND (jsonb_typeof((public_views -> 'collections'::text)) = 'boolean'::text) AND (jsonb_typeof((public_views -> 'realms'::text)) = 'boolean'::text))),
    CONSTRAINT account_rate_tier_check CHECK ((rate_tier = ANY (ARRAY['ordinary'::text, 'trusted'::text, 'service'::text]))),
    CONSTRAINT account_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT account_service_tier_actor CHECK (((rate_tier <> 'service'::text) OR (kind = 'actor'::text))),
    CONSTRAINT account_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text, 'deleted'::text])))
);


--
-- Name: native_terminal_account_ready(access.account); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.native_terminal_account_ready(value access.account) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
 SELECT value.state='deleted' AND value.authn_fenced
  AND value.account_id::text=current_setting('rezics.erasure_terminal',true)
  AND EXISTS (SELECT 1 FROM access.erasure e WHERE e.route=value.route AND e.account_id=value.account_id)
  AND EXISTS (SELECT 1 FROM access.erasure_native_progress p WHERE p.route=value.route AND p.account_id=value.account_id
    AND p.progress_id::text=current_setting('rezics.erasure_progress',true)
    -- Original terminal phase 61 runs only after all appended source phases.
    AND p.phase=74
    AND NOT EXISTS (SELECT 1 FROM access.erasure_native_blocked b WHERE b.progress_id=p.progress_id AND b.phase<>61));
$$;


--
-- Name: operator_fence_page_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.operator_fence_page_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' AND access.native_erasure_delete_ready(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Operator fence pages are immutable';
END;
$$;


--
-- Name: record_native_continuation_roles(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.record_native_continuation_roles() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  root access.committed_continuation;
  artifact text;
  actor uuid;
BEGIN
  artifact := CASE TG_TABLE_NAME WHEN 'committed_continuation' THEN 'root'
    WHEN 'committed_continuation_entry' THEN 'entry'
    WHEN 'committed_continuation_completion' THEN 'completion' ELSE 'page' END;
  SELECT * INTO STRICT root FROM access.committed_continuation
    WHERE route=NEW.route AND continuation_id=NEW.continuation_id;
  INSERT INTO access.erasure_continuation_role(route,account_id,artifact,row_id)
    SELECT NEW.route,id,artifact,NEW.erasure_row_id FROM unnest(ARRAY[root.account_id,root.prior_operator_account_id]) id
    WHERE id IS NOT NULL ON CONFLICT DO NOTHING;
  IF artifact IN ('entry','completion') THEN
    actor := access.erasure_entry_account(NEW.step,NEW.target);
    IF actor IS NOT NULL THEN
      INSERT INTO access.erasure_continuation_role VALUES(NEW.route,actor,artifact,NEW.erasure_row_id) ON CONFLICT DO NOTHING;
    END IF;
  ELSE
    FOR actor IN SELECT access.erasure_entry_account(a->>'step',a->>'target')
      FROM jsonb_array_elements(NEW.allowlist) a LOOP
      IF actor IS NOT NULL THEN
        INSERT INTO access.erasure_continuation_role VALUES(NEW.route,actor,artifact,NEW.erasure_row_id) ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: record_public_account_change(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.record_public_account_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='UPDATE' AND access.native_terminal_account_ready(OLD) THEN
    NEW.public_changed_at := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.public_changed_at := NEW.created_at;
  ELSIF ROW(NEW.account_id, NEW.kind, NEW.state, NEW.authn_fenced, NEW.avatar, NEW.public_views,
            NEW.speakers_listed, NEW.handle, NEW.display_name, NEW.avatar_url, NEW.biography,
            NEW.links, NEW.operator_account_id, NEW.agent_verified, NEW.agent_subject_id)
        IS DISTINCT FROM
        ROW(OLD.account_id, OLD.kind, OLD.state, OLD.authn_fenced, OLD.avatar, OLD.public_views,
            OLD.speakers_listed, OLD.handle, OLD.display_name, OLD.avatar_url, OLD.biography,
            OLD.links, OLD.operator_account_id, OLD.agent_verified, OLD.agent_subject_id) THEN
    NEW.public_changed_at := statement_timestamp();
  ELSE
    NEW.public_changed_at := OLD.public_changed_at;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: record_rating_controller(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.record_rating_controller() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    at := '-infinity';
  ELSIF NEW.operator_account_id IS NOT DISTINCT FROM OLD.operator_account_id THEN
    RETURN NEW;
  ELSE
    -- Native relation and deletion commands supply their authoritative T.
    -- Direct relation removal uses the database transaction time.
    at := COALESCE(NULLIF(current_setting('rezics.operator_at', true), '')::timestamptz,
                   transaction_timestamp());
  END IF;
  INSERT INTO access.rating_counter_controller (route, account_id, effective_at, controller_id)
  VALUES (NEW.route, NEW.account_id, at, COALESCE(NEW.operator_account_id, NEW.account_id))
  ON CONFLICT (route, account_id, effective_at) DO UPDATE SET controller_id = EXCLUDED.controller_id;
  RETURN NEW;
END;
$$;


--
-- Name: workflow_approval_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.workflow_approval_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.operation->>'kind' = 'credential' AND OLD.consumed_at IS NULL AND OLD.consumed_transaction_id IS NULL
    AND NEW.consumed_at IS NOT NULL AND NEW.consumed_transaction_id IS NOT NULL
    AND NEW.consumed_at >= OLD.created_at AND NEW.consumed_at < OLD.expires_at
    AND (to_jsonb(OLD) - 'consumed_at' - 'consumed_transaction_id') = (to_jsonb(NEW) - 'consumed_at' - 'consumed_transaction_id')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Workflow approvals are immutable';
END;
$$;


--
-- Name: account_preferences; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account_preferences (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    spoiler_level integer NOT NULL,
    suitability text NOT NULL,
    version integer NOT NULL,
    shelf jsonb DEFAULT '{}'::jsonb NOT NULL,
    notifications jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT account_preferences_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_preferences_notifications_check CHECK (((jsonb_typeof(notifications) = 'object'::text) AND (octet_length((notifications)::text) <= 2048))),
    CONSTRAINT account_preferences_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT account_preferences_shelf_check CHECK (((jsonb_typeof(shelf) = 'object'::text) AND (octet_length((shelf)::text) <= 16384))),
    CONSTRAINT account_preferences_spoiler_level_check CHECK (((spoiler_level >= 0) AND (spoiler_level <= 2))),
    CONSTRAINT account_preferences_suitability_check CHECK ((suitability = ANY (ARRAY['blur'::text, 'show'::text]))),
    CONSTRAINT account_preferences_version_check CHECK ((version > 0))
);


--
-- Name: agent_page; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.agent_page (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    account_id uuid NOT NULL,
    verification_receipt_id uuid NOT NULL,
    CONSTRAINT agent_page_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11))))
);


--
-- Name: agent_verification_request; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.agent_verification_request (
    route integer NOT NULL,
    request_id uuid NOT NULL,
    account_id uuid NOT NULL,
    account_kind text NOT NULL,
    requested_by uuid,
    catalogue_subject_id uuid NOT NULL,
    statement text NOT NULL,
    links jsonb DEFAULT '[]'::jsonb NOT NULL,
    state text NOT NULL,
    reason text,
    problem_type text,
    problem_detail text,
    decision_receipt_id uuid,
    decided_by uuid,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT agent_verification_request_account_kind_check CHECK ((account_kind = ANY (ARRAY['actor'::text, 'organization'::text]))),
    CONSTRAINT agent_verification_request_check CHECK ((route = ((get_byte(uuid_send(request_id), 10) * 256) + get_byte(uuid_send(request_id), 11)))),
    CONSTRAINT agent_verification_request_check1 CHECK (((state = ANY (ARRAY['approving'::text, 'approved'::text, 'rejected'::text, 'failed'::text])) = (decision_receipt_id IS NOT NULL))),
    CONSTRAINT agent_verification_request_check3 CHECK (((problem_type IS NULL) = (problem_detail IS NULL))),
    CONSTRAINT agent_verification_request_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT agent_verification_request_links_check CHECK (((jsonb_typeof(links) = 'array'::text) AND (jsonb_array_length(links) <= 5))),
    CONSTRAINT agent_verification_request_problem_detail_check CHECK (((problem_detail IS NULL) OR (char_length(problem_detail) <= 512))),
    CONSTRAINT agent_verification_request_problem_type_check CHECK (((problem_type IS NULL) OR ((char_length(problem_type) >= 1) AND (char_length(problem_type) <= 128)))),
    CONSTRAINT agent_verification_request_reason_check CHECK (((reason IS NULL) OR (char_length(reason) <= 500))),
    CONSTRAINT agent_verification_request_route_check CHECK ((route = 0)),
    CONSTRAINT agent_verification_request_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approving'::text, 'approved'::text, 'rejected'::text, 'withdrawn'::text, 'failed'::text]))),
    CONSTRAINT agent_verification_request_statement_check CHECK (((char_length(statement) >= 1) AND (char_length(statement) <= 2000))),
    CONSTRAINT agent_verification_request_updated_at_check CHECK (isfinite(updated_at))
);


--
-- Name: auth_history_proof; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.auth_history_proof (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    phase text NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    continuation_id uuid,
    receipt_id uuid,
    CONSTRAINT auth_history_proof_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT auth_history_proof_check1 CHECK ((((phase = 'native-consumed'::text) AND (continuation_id IS NOT NULL) AND (receipt_id IS NOT NULL)) OR ((phase = 'copies-erased'::text) AND (continuation_id IS NULL) AND (receipt_id IS NULL)))),
    CONSTRAINT auth_history_proof_phase_check CHECK ((phase = ANY (ARRAY['native-consumed'::text, 'copies-erased'::text]))),
    CONSTRAINT auth_history_proof_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT auth_history_proof_version_check CHECK ((version > 0))
);


--
-- Name: committed_continuation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.committed_continuation (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    account_id uuid NOT NULL,
    operation_key text NOT NULL,
    operation_digest text NOT NULL,
    command_key_prefix text NOT NULL,
    barrier_receipt_id uuid NOT NULL,
    barrier_transaction_id uuid NOT NULL,
    minimum_authn_epoch bigint NOT NULL,
    prior_handle text,
    prior_operator_account_id uuid,
    prior_reservation_id uuid,
    allowlist jsonb NOT NULL,
    digest text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    committed_expires_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    completions jsonb DEFAULT '[]'::jsonb NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT committed_continuation_allowlist_check CHECK (access.committed_continuation_entries(allowlist, 1, 4, false)),
    CONSTRAINT committed_continuation_check CHECK ((route = ((get_byte(uuid_send(continuation_id), 10) * 256) + get_byte(uuid_send(continuation_id), 11)))),
    CONSTRAINT committed_continuation_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT committed_continuation_check2 CHECK ((((prior_operator_account_id IS NULL) AND (prior_reservation_id IS NULL)) OR ((prior_operator_account_id IS NOT NULL) AND (prior_reservation_id IS NOT NULL)))),
    CONSTRAINT committed_continuation_check4 CHECK ((expires_at >= committed_expires_at)),
    CONSTRAINT committed_continuation_command_key_prefix_check CHECK ((command_key_prefix ~ '^wf:[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_completions_check CHECK (access.committed_continuation_entries(completions, 0, 4, true)),
    CONSTRAINT committed_continuation_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_lifetime_check CHECK (((committed_expires_at > created_at) AND (committed_expires_at <= (created_at + '00:05:00'::interval)))),
    CONSTRAINT committed_continuation_minimum_authn_epoch_check CHECK ((minimum_authn_epoch > 0)),
    CONSTRAINT committed_continuation_operation_digest_check CHECK ((operation_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_operation_key_check CHECK (((length(operation_key) >= 1) AND (length(operation_key) <= 128))),
    CONSTRAINT committed_continuation_prior_handle_check CHECK (((prior_handle IS NULL) OR (prior_handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text))),
    CONSTRAINT committed_continuation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: committed_continuation_completion; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.committed_continuation_completion (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    step text NOT NULL,
    target text NOT NULL,
    key text NOT NULL,
    digest text NOT NULL,
    receipt_id uuid NOT NULL,
    receipt_key text,
    receipt_digest text,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT committed_continuation_business_receipt_check CHECK (((receipt_key IS NULL) = (receipt_digest IS NULL))),
    CONSTRAINT committed_continuation_completion_check CHECK ((route = ((get_byte(uuid_send(continuation_id), 10) * 256) + get_byte(uuid_send(continuation_id), 11)))),
    CONSTRAINT committed_continuation_completion_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_completion_key_check CHECK (((length(key) >= 1) AND (length(key) <= 240))),
    CONSTRAINT committed_continuation_completion_receipt_digest_check CHECK ((receipt_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_completion_receipt_key_check CHECK (((length(receipt_key) >= 1) AND (length(receipt_key) <= 256))),
    CONSTRAINT committed_continuation_completion_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT committed_continuation_completion_step_check CHECK ((step ~ '^[a-z][a-z0-9-]{0,63}$'::text)),
    CONSTRAINT committed_continuation_completion_target_check CHECK (((length(target) >= 1) AND (length(target) <= 128)))
);


--
-- Name: committed_continuation_entry; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.committed_continuation_entry (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    step text NOT NULL,
    target text NOT NULL,
    key text NOT NULL,
    digest text NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT committed_continuation_entry_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT committed_continuation_entry_key_check CHECK (((length(key) >= 1) AND (length(key) <= 240))),
    CONSTRAINT committed_continuation_entry_step_check CHECK ((step ~ '^[a-z][a-z0-9-]{0,63}$'::text)),
    CONSTRAINT committed_continuation_entry_target_check CHECK (((length(target) >= 1) AND (length(target) <= 128)))
);


--
-- Name: credential_floor_receipt; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.credential_floor_receipt (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    opening_receipt_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    operation_key text NOT NULL,
    effect_reference text NOT NULL,
    effect_digest text NOT NULL,
    purpose text NOT NULL,
    previous_floor bigint NOT NULL,
    minimum_authn_epoch bigint NOT NULL,
    fenced boolean NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT credential_floor_receipt_check CHECK ((minimum_authn_epoch = (previous_floor + 1))),
    CONSTRAINT credential_floor_receipt_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT credential_floor_receipt_previous_floor_check CHECK ((previous_floor > 0)),
    CONSTRAINT credential_floor_receipt_purpose_check CHECK ((purpose = ANY (ARRAY['set-password'::text, 'remove-password'::text, 'remove-key'::text, 'remove-passkey'::text])))
);


--
-- Name: erasure; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    frontier jsonb,
    workflow_until bigint,
    CONSTRAINT erasure_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT erasure_check1 CHECK (((completed_at IS NULL) OR (completed_at >= at))),
    CONSTRAINT erasure_frontier_check CHECK (((frontier IS NULL) OR (jsonb_typeof(frontier) = 'array'::text))),
    CONSTRAINT erasure_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT erasure_version_check CHECK ((version > 0))
);


--
-- Name: erasure_acknowledgement; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_acknowledgement (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    participant text NOT NULL,
    outcome text NOT NULL,
    retained jsonb DEFAULT '[]'::jsonb NOT NULL,
    resolutions jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT erasure_acknowledgement_outcome_check CHECK ((outcome = ANY (ARRAY['erased'::text, 'none'::text]))),
    CONSTRAINT erasure_acknowledgement_participant_check CHECK (((length(participant) >= 1) AND (length(participant) <= 64))),
    CONSTRAINT erasure_acknowledgement_resolutions_check CHECK ((jsonb_typeof(resolutions) = 'object'::text)),
    CONSTRAINT erasure_acknowledgement_retained_check CHECK (((jsonb_typeof(retained) = 'array'::text) AND (jsonb_array_length(retained) <= 16) AND ((outcome = 'erased'::text) OR (retained = '[]'::jsonb))))
);


--
-- Name: erasure_continuation_role; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_continuation_role (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    artifact text NOT NULL,
    row_id uuid NOT NULL,
    CONSTRAINT erasure_continuation_role_artifact_check CHECK ((artifact = ANY (ARRAY['root'::text, 'entry'::text, 'completion'::text, 'page'::text]))),
    CONSTRAINT erasure_continuation_role_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: erasure_late_item; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_late_item (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    participant text NOT NULL,
    locator text NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT erasure_late_item_locator_check CHECK (((locator COLLATE "C") ~ '^[ -~]{1,255}$'::text))
);


--
-- Name: erasure_locator_work; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_locator_work (
    workflow_id text NOT NULL,
    effect text NOT NULL,
    opened_at bigint NOT NULL,
    state text DEFAULT 'open'::text NOT NULL,
    resolution_transaction_id uuid,
    CONSTRAINT erasure_locator_work_check CHECK (((state = 'resolved'::text) = (resolution_transaction_id IS NOT NULL))),
    CONSTRAINT erasure_locator_work_state_check CHECK ((state = ANY (ARRAY['open'::text, 'done'::text, 'resolved'::text])))
);


--
-- Name: erasure_native_blocked; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_native_blocked (
    progress_id uuid NOT NULL,
    phase integer NOT NULL,
    page integer NOT NULL,
    consumer_index integer DEFAULT 0 NOT NULL,
    reason text NOT NULL,
    CONSTRAINT erasure_native_blocked_consumer_index_check CHECK (((consumer_index >= 0) AND (consumer_index < 100))),
    CONSTRAINT erasure_native_blocked_page_check CHECK ((page >= 0)),
    CONSTRAINT erasure_native_blocked_phase_check CHECK ((phase >= 0)),
    CONSTRAINT erasure_native_blocked_reason_check CHECK ((reason = ANY (ARRAY['handle-consumer'::text, 'membership-terminal-consumer'::text, 'organization-close-consumer'::text, 'verification-decision-consumer'::text, 'verification-reversal-consumer'::text, 'controller-transition-consumer'::text, 'rating-controller-projection-custody'::text, 'organization-cursor-cutover'::text, 'rate-binding-deployment-coverage'::text, 'auth-fence-release-witness-unavailable'::text, 'continuation-barrier-consumer'::text, 'deletion-local-consumer'::text, 'native-terminal-consumer'::text, 'approval-consumer-proof-unavailable'::text, 'opening-consumer-proof-unavailable'::text, 'credential-consumer-proof-unavailable'::text, 'continuation-child-consumer'::text, 'operator-page-consumer'::text, 'terminal-inventory'::text, 'account-discovery-consumer'::text, 'verification-source-custody'::text, 'realm-succession-source-custody'::text])))
);


--
-- Name: erasure_native_consumed_child; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_native_consumed_child (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    artifact text NOT NULL,
    entry_key bytea NOT NULL,
    progress_id uuid NOT NULL,
    CONSTRAINT erasure_native_consumed_child_artifact_check CHECK ((artifact = ANY (ARRAY['entry'::text, 'completion'::text, 'page'::text]))),
    CONSTRAINT erasure_native_consumed_child_entry_key_check CHECK ((octet_length(entry_key) = 32))
);


--
-- Name: erasure_native_coverage; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_native_coverage (
    name text NOT NULL,
    covered boolean NOT NULL,
    CONSTRAINT erasure_native_coverage_name_check CHECK ((name = 'rate-account-binding'::text))
);


--
-- Name: erasure_native_progress; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_native_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    progress_id uuid NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    phase integer DEFAULT 0 NOT NULL,
    page integer DEFAULT 0 NOT NULL,
    pending text,
    retry_phase integer DEFAULT '-1'::integer NOT NULL,
    native_complete_at timestamp with time zone,
    CONSTRAINT erasure_native_progress_page_check CHECK ((page >= 0)),
    CONSTRAINT erasure_native_progress_pending_check CHECK ((pending = ANY (ARRAY['handle-consumer'::text, 'native-inventory'::text, 'shared-history-producer'::text]))),
    CONSTRAINT erasure_native_progress_phase_check CHECK ((phase >= 0)),
    CONSTRAINT erasure_native_progress_retry_phase_check CHECK ((retry_phase >= '-1'::integer)),
    CONSTRAINT erasure_native_progress_version_check CHECK ((version = 1))
);


--
-- Name: erasure_progress; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.erasure_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    store text NOT NULL,
    role text NOT NULL,
    partition_no integer NOT NULL,
    cursor text[],
    state text DEFAULT 'discovering'::text NOT NULL,
    last_page integer DEFAULT '-1'::integer NOT NULL,
    result jsonb,
    CONSTRAINT erasure_progress_last_page_check CHECK ((last_page >= '-1'::integer)),
    CONSTRAINT erasure_progress_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT erasure_progress_result_check CHECK ((octet_length((result)::text) <= 65536)),
    CONSTRAINT erasure_progress_state_check CHECK ((state = ANY (ARRAY['discovering'::text, 'discovered'::text])))
);


--
-- Name: exposure_opening; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.exposure_opening (
    "group" text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    route integer DEFAULT 0 NOT NULL,
    CONSTRAINT exposure_opening_group_check CHECK (("group" ~ '^[a-z][a-z_-]{0,62}$'::text)),
    CONSTRAINT exposure_opening_route_check CHECK ((route = 0)),
    CONSTRAINT exposure_opening_valid_check CHECK (((NOT isempty(valid)) AND (NOT lower_inf(valid)) AND lower_inc(valid) AND (NOT upper_inc(valid))))
);


--
-- Name: governance_bootstrap; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.governance_bootstrap (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    account_id uuid,
    transaction_id uuid,
    CONSTRAINT governance_bootstrap_attribution_check CHECK (((account_id IS NULL) = (transaction_id IS NULL))),
    CONSTRAINT governance_bootstrap_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT governance_bootstrap_resource_id_check CHECK ((resource_id = '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT governance_bootstrap_route_check CHECK ((route = 0))
);


--
-- Name: governance_reach; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.governance_reach (
    route integer NOT NULL,
    transaction_id uuid NOT NULL,
    action text NOT NULL,
    resource_id uuid NOT NULL,
    actor_account_id uuid NOT NULL,
    CONSTRAINT governance_reach_action_check CHECK ((action = ANY (ARRAY['moderation:takedown'::text, 'moderation:read_reports'::text, 'post:erase'::text, 'media:erase'::text, 'access:grant'::text]))),
    CONSTRAINT governance_reach_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT governance_reach_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: handle_claim; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.handle_claim (
    discovery_revision bigint DEFAULT 0 NOT NULL,
    route integer NOT NULL,
    normalized_handle text NOT NULL COLLATE pg_catalog."C",
    account_id uuid,
    state text NOT NULL,
    expires_at timestamp with time zone,
    reserved_until timestamp with time zone,
    transaction_id uuid,
    reservation_id uuid,
    hold_operation_id text,
    hold_expected_handle text,
    former_until timestamp with time zone,
    CONSTRAINT handle_claim_check CHECK ((route = ((get_byte(sha256(convert_to(normalized_handle, 'UTF8'::name)), 0) * 256) + get_byte(sha256(convert_to(normalized_handle, 'UTF8'::name)), 1)))),
    CONSTRAINT handle_claim_disposition CHECK ((((state = 'retired'::text) AND (account_id IS NULL) AND (transaction_id IS NULL) AND (expires_at IS NULL) AND (reserved_until IS NULL) AND (reservation_id IS NULL) AND (hold_operation_id IS NULL) AND (hold_expected_handle IS NULL) AND (former_until IS NULL)) OR ((state = ANY (ARRAY['pending'::text, 'active'::text, 'reserved'::text])) AND (account_id IS NOT NULL) AND (transaction_id IS NOT NULL) AND (((state = 'pending'::text) AND (expires_at IS NOT NULL) AND (reserved_until IS NULL)) OR ((state = 'active'::text) AND (expires_at IS NULL) AND (reserved_until IS NULL)) OR ((state = 'reserved'::text) AND (expires_at IS NULL) AND (reserved_until IS NOT NULL)))))),
    CONSTRAINT handle_claim_former_until_check CHECK (((former_until IS NULL) OR (state = ANY (ARRAY['pending'::text, 'reserved'::text])))),
    CONSTRAINT handle_claim_normalized_handle_check CHECK ((normalized_handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT handle_claim_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: lifecycle_coordination; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_coordination (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    related_account_id uuid NOT NULL,
    purpose text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT lifecycle_coordination_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT lifecycle_coordination_purpose_check CHECK ((purpose = ANY (ARRAY['membership'::text, 'operator'::text])))
);


--
-- Name: lifecycle_fence_receipt; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_fence_receipt (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    minimum_authn_epoch bigint NOT NULL,
    kind text NOT NULL,
    prior_operator_account_id uuid,
    transaction_id uuid NOT NULL,
    operator_account_id uuid,
    operator_reservation_id uuid,
    operator_continuation_id uuid,
    CONSTRAINT lifecycle_fence_operator_origin CHECK ((((operator_account_id IS NULL) AND (operator_reservation_id IS NULL) AND (operator_continuation_id IS NULL)) OR ((operator_account_id IS NOT NULL) AND (operator_reservation_id IS NOT NULL) AND (operator_continuation_id IS NOT NULL)))),
    CONSTRAINT lifecycle_fence_receipt_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT lifecycle_fence_receipt_kind_check CHECK ((kind = ANY (ARRAY['fence'::text, 'tombstone'::text]))),
    CONSTRAINT lifecycle_fence_receipt_minimum_authn_epoch_check CHECK ((minimum_authn_epoch > 0))
);


--
-- Name: lifecycle_handle_effect; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_handle_effect (
    route integer NOT NULL,
    normalized_handle text NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    operation_id text NOT NULL,
    effect text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT lifecycle_handle_effect_effect_check CHECK ((effect = ANY (ARRAY['active'::text, 'reserved'::text])))
);


--
-- Name: lifecycle_handle_operation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_handle_operation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    operation_id text NOT NULL,
    handle text NOT NULL,
    reservation_id uuid NOT NULL,
    expected_handle text,
    old_reservation_id uuid,
    state text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT lifecycle_handle_operation_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT lifecycle_handle_operation_state_check CHECK ((state = ANY (ARRAY['published'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: lifecycle_membership_slot; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_membership_slot (
    route integer NOT NULL,
    organization_id uuid NOT NULL,
    member_account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    terminal boolean DEFAULT false NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT lifecycle_membership_slot_check CHECK ((route = ((get_byte(uuid_send(organization_id), 10) * 256) + get_byte(uuid_send(organization_id), 11))))
);


--
-- Name: lifecycle_registration_expiry; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.lifecycle_registration_expiry (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    handle text NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT lifecycle_registration_expiry_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))))
);


--
-- Name: membership_inverse; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.membership_inverse (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    group_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    source_transaction_id uuid,
    CONSTRAINT membership_inverse_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT membership_inverse_kind_check CHECK ((kind = ANY (ARRAY['organization'::text, 'realm'::text]))),
    CONSTRAINT membership_inverse_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: membership_inverse_coverage; Type: VIEW; Schema: access; Owner: -
--

CREATE VIEW access.membership_inverse_coverage AS
 SELECT route,
    account_id,
    membership_inverse_complete AS complete
   FROM access.account;


--
-- Name: membership_inverse_terminal; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.membership_inverse_terminal (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    group_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    reservation_transaction_id uuid NOT NULL,
    proof_transaction_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT membership_inverse_terminal_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT membership_inverse_terminal_kind_check CHECK ((kind = ANY (ARRAY['organization'::text, 'realm'::text])))
);


--
-- Name: operator_fence_page; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.operator_fence_page (
    route integer NOT NULL,
    continuation_id uuid NOT NULL,
    page_key text NOT NULL,
    cursor text,
    next_cursor text,
    allowlist jsonb NOT NULL,
    erasure_row_id uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT operator_fence_page_allowlist_check CHECK (access.committed_continuation_entries(allowlist, 0, 101, false)),
    CONSTRAINT operator_fence_page_page_key_check CHECK ((page_key ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: operator_opening_receipt; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.operator_opening_receipt (
    route integer NOT NULL,
    operator_account_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    subject_account_id uuid NOT NULL,
    acting_human_id uuid NOT NULL,
    purpose text NOT NULL,
    action text NOT NULL,
    client_id text NOT NULL,
    scopes text[] NOT NULL,
    requested_by text,
    human_authn_epoch bigint NOT NULL,
    human_epoch_floor bigint NOT NULL,
    operator_epoch_floor bigint NOT NULL,
    subject_epoch_floor bigint NOT NULL,
    relation_version bigint NOT NULL,
    reservation_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    transaction_id uuid NOT NULL,
    consumed_transaction_id uuid,
    credential_purpose text,
    credential_operation_key text,
    credential_effect_reference text,
    credential_effect_digest text,
    erasure_principal_id uuid GENERATED ALWAYS AS (access.erasure_requested_principal(requested_by)) STORED,
    CONSTRAINT credential_binding_closed CHECK ((((credential_purpose IS NULL) AND (credential_operation_key IS NULL) AND (credential_effect_reference IS NULL) AND (credential_effect_digest IS NULL)) OR ((purpose = 'credential-management'::text) AND (credential_purpose IS NOT NULL) AND (credential_purpose = ANY (ARRAY['set-password'::text, 'remove-password'::text, 'add-key'::text, 'remove-key'::text])) AND (credential_operation_key IS NOT NULL) AND ((length(credential_operation_key) >= 1) AND (length(credential_operation_key) <= 255)) AND (credential_effect_reference IS NOT NULL) AND ((length(credential_effect_reference) >= 1) AND (length(credential_effect_reference) <= 4096)) AND (credential_effect_digest IS NOT NULL) AND (credential_effect_digest ~ '^[a-f0-9]{64}$'::text)))),
    CONSTRAINT operator_opening_receipt_check CHECK ((route = ((get_byte(uuid_send(operator_account_id), 10) * 256) + get_byte(uuid_send(operator_account_id), 11)))),
    CONSTRAINT operator_opening_receipt_check1 CHECK ((expires_at <= (created_at + '00:01:00'::interval))),
    CONSTRAINT operator_opening_receipt_human_authn_epoch_check CHECK ((human_authn_epoch > 0)),
    CONSTRAINT operator_opening_receipt_purpose_check CHECK ((purpose = ANY (ARRAY['session'::text, 'credential-management'::text])))
);


--
-- Name: operator_relation_slot; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.operator_relation_slot (
    route integer NOT NULL,
    subject_account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    operator_account_id uuid NOT NULL,
    terminal boolean NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT operator_relation_slot_check CHECK ((route = ((get_byte(uuid_send(subject_account_id), 10) * 256) + get_byte(uuid_send(subject_account_id), 11))))
);


--
-- Name: organization_close; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.organization_close (
    route integer NOT NULL,
    organization_id uuid NOT NULL,
    receipt_id uuid NOT NULL,
    handle text,
    step integer DEFAULT 0 NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    handle_key text NOT NULL,
    cursor_row_key uuid,
    CONSTRAINT organization_close_check CHECK ((route = ((get_byte(uuid_send(organization_id), 10) * 256) + get_byte(uuid_send(organization_id), 11))))
);


--
-- Name: organization_member; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.organization_member (
    route integer NOT NULL,
    organization_id uuid NOT NULL,
    member_account_id uuid NOT NULL,
    role text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    row_key uuid DEFAULT gen_random_uuid() NOT NULL,
    CONSTRAINT organization_member_check CHECK ((route = ((get_byte(uuid_send(organization_id), 10) * 256) + get_byte(uuid_send(organization_id), 11)))),
    CONSTRAINT organization_member_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text]))),
    CONSTRAINT organization_member_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT organization_member_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: principal_assignment; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.principal_assignment (
    route integer NOT NULL,
    principal_id uuid NOT NULL,
    request_id uuid NOT NULL,
    assigned_actor_id uuid NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    creator_principal_id uuid,
    issued_valid tstzrange NOT NULL,
    revoked_at timestamp with time zone,
    CONSTRAINT principal_assignment_check CHECK ((route = ((get_byte(uuid_send(principal_id), 10) * 256) + get_byte(uuid_send(principal_id), 11)))),
    CONSTRAINT principal_assignment_check1 CHECK ((creator_principal_id = principal_id)),
    CONSTRAINT principal_assignment_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT principal_assignment_valid_check CHECK ((((revoked_at IS NOT NULL) AND isempty(valid)) OR ((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid)))))
);


--
-- Name: rating_counter_controller; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.rating_counter_controller (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    controller_id uuid NOT NULL,
    CONSTRAINT rating_counter_controller_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))))
);


--
-- Name: resource_denial; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_denial (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    subject_role text DEFAULT ''::text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint NOT NULL,
    CONSTRAINT resource_denial_action_check CHECK ((action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'::text)),
    CONSTRAINT resource_denial_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_denial_reason_check CHECK ((reason = ANY (ARRAY['resource'::text, 'suspension'::text, 'realm_ban'::text]))),
    CONSTRAINT resource_denial_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_denial_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_denial_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: resource_denial_erasure_key_seq; Type: SEQUENCE; Schema: access; Owner: -
--

ALTER TABLE access.resource_denial ALTER COLUMN erasure_key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME access.resource_denial_erasure_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: resource_grant; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_grant (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    subject_role text DEFAULT ''::text NOT NULL,
    action text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    subject_kind text DEFAULT 'identity'::text NOT NULL,
    erasure_key bigint NOT NULL,
    CONSTRAINT resource_grant_action_check CHECK ((action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'::text)),
    CONSTRAINT resource_grant_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_grant_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_grant_subject_check CHECK ((((subject_kind = 'identity'::text) AND (subject_id <> '00000000-0000-0000-0000-000000000000'::uuid)) OR ((subject_kind = 'active_accounts'::text) AND (subject_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (subject_role = ''::text)))),
    CONSTRAINT resource_grant_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['identity'::text, 'active_accounts'::text]))),
    CONSTRAINT resource_grant_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_grant_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: resource_grant_erasure_key_seq; Type: SEQUENCE; Schema: access; Owner: -
--

ALTER TABLE access.resource_grant ALTER COLUMN erasure_key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME access.resource_grant_erasure_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: resource_initialization; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_initialization (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    resource_type text NOT NULL,
    creator_id uuid,
    initialized_at timestamp with time zone,
    CONSTRAINT resource_initialization_attribution_check CHECK (((creator_id IS NULL) = (initialized_at IS NULL))),
    CONSTRAINT resource_initialization_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_initialization_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: resource_role_grant; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_role_grant (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    subject_kind text DEFAULT 'identity'::text NOT NULL,
    subject_id uuid NOT NULL,
    subject_role text DEFAULT ''::text NOT NULL,
    grant_role text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint NOT NULL,
    CONSTRAINT resource_role_grant_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_role_grant_check1 CHECK ((((subject_kind = 'identity'::text) AND (subject_id <> '00000000-0000-0000-0000-000000000000'::uuid)) OR ((subject_kind = 'active_accounts'::text) AND (subject_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (subject_role = ''::text)))),
    CONSTRAINT resource_role_grant_grant_role_check CHECK ((grant_role ~ '^[a-z][a-z0-9_.-]*$'::text)),
    CONSTRAINT resource_role_grant_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_role_grant_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['identity'::text, 'active_accounts'::text]))),
    CONSTRAINT resource_role_grant_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_role_grant_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: resource_role_grant_erasure_key_seq; Type: SEQUENCE; Schema: access; Owner: -
--

ALTER TABLE access.resource_role_grant ALTER COLUMN erasure_key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME access.resource_role_grant_erasure_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: standing_parent_installation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.standing_parent_installation (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    actions text[] NOT NULL,
    transaction_id uuid NOT NULL,
    erasure_key bigint NOT NULL,
    CONSTRAINT standing_parent_installation_actions_check CHECK ((cardinality(actions) > 0)),
    CONSTRAINT standing_parent_installation_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT standing_parent_installation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: standing_parent_installation_erasure_key_seq; Type: SEQUENCE; Schema: access; Owner: -
--

ALTER TABLE access.standing_parent_installation ALTER COLUMN erasure_key ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME access.standing_parent_installation_erasure_key_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workflow_approval; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.workflow_approval (
    route integer NOT NULL,
    approval_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    client_id text NOT NULL,
    scopes text[] NOT NULL,
    requested_by text,
    authn_epoch bigint NOT NULL,
    operation_key text NOT NULL,
    operation jsonb NOT NULL,
    digest text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    jwt_expires_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    consumed_at timestamp with time zone,
    consumed_transaction_id uuid,
    erasure_subject_id uuid GENERATED ALWAYS AS ((
CASE (operation ->> 'kind'::text)
    WHEN 'credential'::text THEN (operation ->> 'subjectAccountId'::text)
    WHEN 'membership'::text THEN (operation ->> 'organizationId'::text)
    WHEN 'opening'::text THEN (operation ->> 'subjectAccountId'::text)
    WHEN 'rename'::text THEN (operation ->> 'accountId'::text)
    WHEN 'delete'::text THEN (operation ->> 'accountId'::text)
    WHEN 'revoke'::text THEN (operation ->> 'accountId'::text)
    WHEN 'fence-operator'::text THEN (operation ->> 'accountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_operator_id uuid GENERATED ALWAYS AS ((
CASE
    WHEN ((operation ->> 'kind'::text) = ANY (ARRAY['automated'::text, 'opening'::text, 'transfer'::text, 'transfer-acceptance'::text])) THEN (operation ->> 'operatorAccountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_member_id uuid GENERATED ALWAYS AS ((
CASE
    WHEN ((operation ->> 'kind'::text) = 'membership'::text) THEN (operation ->> 'memberAccountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_previous_operator_id uuid GENERATED ALWAYS AS ((
CASE
    WHEN ((operation ->> 'kind'::text) = ANY (ARRAY['transfer'::text, 'transfer-acceptance'::text])) THEN ((operation -> 'previous'::text) ->> 'operatorAccountId'::text)
    WHEN ((operation ->> 'kind'::text) = 'delete'::text) THEN ((operation -> 'responsibility'::text) ->> 'operatorAccountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_previous_subject_id uuid GENERATED ALWAYS AS ((
CASE
    WHEN ((operation ->> 'kind'::text) = ANY (ARRAY['transfer'::text, 'transfer-acceptance'::text])) THEN ((operation -> 'previous'::text) ->> 'subjectAccountId'::text)
    ELSE NULL::text
END)::uuid) STORED,
    erasure_principal_id uuid GENERATED ALWAYS AS (access.erasure_requested_principal(requested_by)) STORED,
    CONSTRAINT credential_expiry CHECK ((((operation ->> 'kind'::text) <> 'credential'::text) OR (expires_at <= (created_at + '00:01:00'::interval)))),
    CONSTRAINT workflow_approval_authn_epoch_check CHECK (((authn_epoch > 0) AND (authn_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT workflow_approval_check CHECK ((route = ((get_byte(uuid_send(approval_id), 10) * 256) + get_byte(uuid_send(approval_id), 11)))),
    CONSTRAINT workflow_approval_check1 CHECK ((route = ((get_byte(uuid_send(actor_id), 10) * 256) + get_byte(uuid_send(actor_id), 11)))),
    CONSTRAINT workflow_approval_check2 CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:05:00'::interval)) AND (expires_at <= jwt_expires_at))),
    CONSTRAINT workflow_approval_client_id_check CHECK (((length(client_id) >= 1) AND (length(client_id) <= 1024))),
    CONSTRAINT workflow_approval_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_approval_operation_check CHECK (((jsonb_typeof(operation) = 'object'::text) AND (octet_length((operation)::text) <=
CASE
    WHEN ((operation ->> 'kind'::text) = 'client-reduction'::text) THEN 71167
    ELSE 16384
END))),
    CONSTRAINT workflow_approval_operation_key_check CHECK (((length(operation_key) >= 1) AND (length(operation_key) <= 255))),
    CONSTRAINT workflow_approval_requested_by_check CHECK ((length(requested_by) <= 100)),
    CONSTRAINT workflow_approval_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT workflow_approval_scopes_check CHECK (((cardinality(scopes) <= 512) AND (octet_length(array_to_string(scopes, ' '::text)) <= 66047)))
);


--
-- Name: write_rate_chunk; Type: TABLE; Schema: access; Owner: -
--

CREATE UNLOGGED TABLE access.write_rate_chunk (
    route integer NOT NULL,
    identity_digest text NOT NULL,
    operation_id uuid NOT NULL,
    chunk_index bigint NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    account_id uuid,
    CONSTRAINT write_rate_chunk_chunk_index_check CHECK (((chunk_index >= 0) AND (chunk_index <= '9007199254740991'::bigint))),
    CONSTRAINT write_rate_chunk_expires_at_check CHECK (isfinite(expires_at)),
    CONSTRAINT write_rate_chunk_identity_digest_check CHECK ((identity_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT write_rate_chunk_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: write_rate_counter; Type: TABLE; Schema: access; Owner: -
--

CREATE UNLOGGED TABLE access.write_rate_counter (
    identity_digest text NOT NULL,
    family text NOT NULL,
    count integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    route integer NOT NULL,
    account_id uuid,
    CONSTRAINT write_rate_counter_count_check CHECK ((count >= 0)),
    CONSTRAINT write_rate_counter_expires_at_check CHECK (isfinite(expires_at)),
    CONSTRAINT write_rate_counter_family_check CHECK ((family ~ '^[a-z][a-z0-9_.:-]{0,63}$'::text)),
    CONSTRAINT write_rate_counter_identity_digest_check CHECK ((identity_digest ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT write_rate_counter_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (route, account_id);


--
-- Name: account_preferences account_preferences_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account_preferences
    ADD CONSTRAINT account_preferences_pkey PRIMARY KEY (route, account_id);


--
-- Name: agent_page agent_page_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_page
    ADD CONSTRAINT agent_page_pkey PRIMARY KEY (route, subject_id);


--
-- Name: agent_verification_request agent_verification_request_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.agent_verification_request
    ADD CONSTRAINT agent_verification_request_pkey PRIMARY KEY (route, request_id);


--
-- Name: auth_history_proof auth_history_proof_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_history_proof
    ADD CONSTRAINT auth_history_proof_pkey PRIMARY KEY (route, account_id, phase);


--
-- Name: committed_continuation_completion committed_continuation_completion_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation_completion
    ADD CONSTRAINT committed_continuation_completion_pkey PRIMARY KEY (route, continuation_id, step, target, key);


--
-- Name: committed_continuation_entry committed_continuation_entry_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation_entry
    ADD CONSTRAINT committed_continuation_entry_pkey PRIMARY KEY (route, continuation_id, step, target, key);


--
-- Name: committed_continuation committed_continuation_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation
    ADD CONSTRAINT committed_continuation_pkey PRIMARY KEY (route, continuation_id);


--
-- Name: committed_continuation committed_continuation_route_operation_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation
    ADD CONSTRAINT committed_continuation_route_operation_key_key UNIQUE (route, operation_key);


--
-- Name: credential_floor_receipt credential_floor_receipt_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.credential_floor_receipt
    ADD CONSTRAINT credential_floor_receipt_pkey PRIMARY KEY (route, account_id, opening_receipt_id);


--
-- Name: erasure_acknowledgement erasure_acknowledgement_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_acknowledgement
    ADD CONSTRAINT erasure_acknowledgement_pkey PRIMARY KEY (route, account_id, participant);


--
-- Name: erasure_continuation_role erasure_continuation_role_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_continuation_role
    ADD CONSTRAINT erasure_continuation_role_pkey PRIMARY KEY (account_id, route, artifact, row_id);


--
-- Name: erasure_late_item erasure_late_item_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_late_item
    ADD CONSTRAINT erasure_late_item_pkey PRIMARY KEY (route, account_id, participant, locator);


--
-- Name: erasure_locator_work erasure_locator_work_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_locator_work
    ADD CONSTRAINT erasure_locator_work_pkey PRIMARY KEY (workflow_id);


--
-- Name: erasure_native_blocked erasure_native_blocked_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_blocked
    ADD CONSTRAINT erasure_native_blocked_pkey PRIMARY KEY (progress_id, phase);


--
-- Name: erasure_native_consumed_child erasure_native_consumed_child_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_consumed_child
    ADD CONSTRAINT erasure_native_consumed_child_pkey PRIMARY KEY (route, continuation_id, artifact, entry_key);


--
-- Name: erasure_native_coverage erasure_native_coverage_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_coverage
    ADD CONSTRAINT erasure_native_coverage_pkey PRIMARY KEY (name);


--
-- Name: erasure_native_progress erasure_native_progress_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_progress
    ADD CONSTRAINT erasure_native_progress_pkey PRIMARY KEY (route, account_id);


--
-- Name: erasure_native_progress erasure_native_progress_progress_id_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_progress
    ADD CONSTRAINT erasure_native_progress_progress_id_key UNIQUE (progress_id);


--
-- Name: erasure erasure_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure
    ADD CONSTRAINT erasure_pkey PRIMARY KEY (route, account_id);


--
-- Name: erasure_progress erasure_progress_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_progress
    ADD CONSTRAINT erasure_progress_pkey PRIMARY KEY (route, account_id, store, role);


--
-- Name: exposure_opening exposure_opening_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.exposure_opening
    ADD CONSTRAINT exposure_opening_pkey PRIMARY KEY (route, "group", valid WITHOUT OVERLAPS);


--
-- Name: governance_bootstrap governance_bootstrap_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.governance_bootstrap
    ADD CONSTRAINT governance_bootstrap_pkey PRIMARY KEY (route, resource_id);


--
-- Name: governance_reach governance_reach_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.governance_reach
    ADD CONSTRAINT governance_reach_pkey PRIMARY KEY (route, transaction_id, action, resource_id);


--
-- Name: handle_claim handle_claim_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.handle_claim
    ADD CONSTRAINT handle_claim_pkey PRIMARY KEY (route, normalized_handle);


--
-- Name: lifecycle_coordination lifecycle_coordination_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_coordination
    ADD CONSTRAINT lifecycle_coordination_pkey PRIMARY KEY (route, account_id, reservation_id);


--
-- Name: lifecycle_fence_receipt lifecycle_fence_receipt_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_fence_receipt
    ADD CONSTRAINT lifecycle_fence_receipt_pkey PRIMARY KEY (route, account_id, receipt_id);


--
-- Name: lifecycle_handle_effect lifecycle_handle_effect_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_handle_effect
    ADD CONSTRAINT lifecycle_handle_effect_pkey PRIMARY KEY (route, normalized_handle, account_id, reservation_id, operation_id, effect);


--
-- Name: lifecycle_handle_operation lifecycle_handle_operation_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_handle_operation
    ADD CONSTRAINT lifecycle_handle_operation_pkey PRIMARY KEY (route, account_id, operation_id);


--
-- Name: lifecycle_membership_slot lifecycle_membership_slot_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_membership_slot
    ADD CONSTRAINT lifecycle_membership_slot_pkey PRIMARY KEY (route, organization_id, member_account_id, reservation_id);


--
-- Name: lifecycle_registration_expiry lifecycle_registration_expiry_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.lifecycle_registration_expiry
    ADD CONSTRAINT lifecycle_registration_expiry_pkey PRIMARY KEY (route, account_id, reservation_id);


--
-- Name: membership_inverse membership_inverse_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.membership_inverse
    ADD CONSTRAINT membership_inverse_pkey PRIMARY KEY (route, account_id, kind, group_id);


--
-- Name: membership_inverse_terminal membership_inverse_terminal_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.membership_inverse_terminal
    ADD CONSTRAINT membership_inverse_terminal_pkey PRIMARY KEY (route, account_id, kind, group_id, reservation_id);


--
-- Name: operator_fence_page operator_fence_page_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.operator_fence_page
    ADD CONSTRAINT operator_fence_page_pkey PRIMARY KEY (route, continuation_id, page_key);


--
-- Name: operator_opening_receipt operator_opening_receipt_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.operator_opening_receipt
    ADD CONSTRAINT operator_opening_receipt_pkey PRIMARY KEY (route, operator_account_id, receipt_id);


--
-- Name: operator_relation_slot operator_relation_slot_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.operator_relation_slot
    ADD CONSTRAINT operator_relation_slot_pkey PRIMARY KEY (route, subject_account_id, reservation_id);


--
-- Name: organization_close organization_close_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.organization_close
    ADD CONSTRAINT organization_close_pkey PRIMARY KEY (route, organization_id);


--
-- Name: organization_member organization_member_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.organization_member
    ADD CONSTRAINT organization_member_pkey PRIMARY KEY (route, organization_id, member_account_id, valid WITHOUT OVERLAPS);


--
-- Name: principal_assignment principal_assignment_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.principal_assignment
    ADD CONSTRAINT principal_assignment_pkey PRIMARY KEY (route, principal_id, request_id);


--
-- Name: rating_counter_controller rating_counter_controller_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.rating_counter_controller
    ADD CONSTRAINT rating_counter_controller_pkey PRIMARY KEY (route, account_id, effective_at);


--
-- Name: resource_denial resource_denial_erasure_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_denial
    ADD CONSTRAINT resource_denial_erasure_key_key UNIQUE (erasure_key);


--
-- Name: resource_denial resource_denial_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_denial
    ADD CONSTRAINT resource_denial_pkey PRIMARY KEY (route, resource_id, subject_id, subject_role, action, reason, valid WITHOUT OVERLAPS);


--
-- Name: resource_grant resource_grant_erasure_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_grant
    ADD CONSTRAINT resource_grant_erasure_key_key UNIQUE (erasure_key);


--
-- Name: resource_grant resource_grant_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_grant
    ADD CONSTRAINT resource_grant_pkey PRIMARY KEY (route, resource_id, subject_kind, subject_id, subject_role, action, valid WITHOUT OVERLAPS);


--
-- Name: resource_initialization resource_initialization_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_initialization
    ADD CONSTRAINT resource_initialization_pkey PRIMARY KEY (route, resource_id);


--
-- Name: resource_role_grant resource_role_grant_erasure_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_role_grant
    ADD CONSTRAINT resource_role_grant_erasure_key_key UNIQUE (erasure_key);


--
-- Name: resource_role_grant resource_role_grant_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_role_grant
    ADD CONSTRAINT resource_role_grant_pkey PRIMARY KEY (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid WITHOUT OVERLAPS);


--
-- Name: standing_parent_installation standing_parent_installation_erasure_key_key; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.standing_parent_installation
    ADD CONSTRAINT standing_parent_installation_erasure_key_key UNIQUE (erasure_key);


--
-- Name: standing_parent_installation standing_parent_installation_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.standing_parent_installation
    ADD CONSTRAINT standing_parent_installation_pkey PRIMARY KEY (route, resource_id, actions);


--
-- Name: workflow_approval workflow_approval_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.workflow_approval
    ADD CONSTRAINT workflow_approval_pkey PRIMARY KEY (route, approval_id);


--
-- Name: write_rate_chunk write_rate_chunk_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.write_rate_chunk
    ADD CONSTRAINT write_rate_chunk_pkey PRIMARY KEY (route, identity_digest, operation_id, chunk_index);


--
-- Name: write_rate_counter write_rate_counter_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.write_rate_counter
    ADD CONSTRAINT write_rate_counter_pkey PRIMARY KEY (route, identity_digest, family);


--
-- Name: account_active_pages; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX account_active_pages ON access.account USING btree (route, account_id) WHERE ((state = 'active'::text) AND (NOT authn_fenced));


--
-- Name: account_agent_pages; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX account_agent_pages ON access.account USING btree (route, account_id) WHERE ((state = 'active'::text) AND (NOT authn_fenced) AND (handle IS NOT NULL));


--
-- Name: agent_verification_account_latest_idx; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX agent_verification_account_latest_idx ON access.agent_verification_request USING btree (route, account_id, created_at DESC, request_id DESC);


--
-- Name: agent_verification_active_account_idx; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX agent_verification_active_account_idx ON access.agent_verification_request USING btree (route, account_id) WHERE (state = ANY (ARRAY['pending'::text, 'approving'::text]));


--
-- Name: agent_verification_pending_page_idx; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX agent_verification_pending_page_idx ON access.agent_verification_request USING btree (route, created_at, request_id) WHERE (state = 'pending'::text);


--
-- Name: committed_continuation_auth_source; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_auth_source ON access.committed_continuation USING btree (route, account_id, barrier_receipt_id) WHERE (allowlist @> '[{"step": "erase-auth-owner"}]'::jsonb);


--
-- Name: committed_continuation_barrier; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_barrier ON access.committed_continuation USING btree (route, account_id, barrier_receipt_id);


--
-- Name: committed_continuation_completion_erasure_row; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_completion_erasure_row ON access.committed_continuation_completion USING btree (route, erasure_row_id);


--
-- Name: committed_continuation_entry_erasure_row; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_entry_erasure_row ON access.committed_continuation_entry USING btree (route, erasure_row_id);


--
-- Name: committed_continuation_erasure_row; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_erasure_row ON access.committed_continuation USING btree (route, erasure_row_id);


--
-- Name: committed_continuation_operator_latest; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX committed_continuation_operator_latest ON access.committed_continuation USING btree (route, account_id, minimum_authn_epoch DESC) WHERE (allowlist @> '[{"step": "operator-responsibility-page"}]'::jsonb);


--
-- Name: erasure_account_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_account_account_id ON access.account USING btree (account_id, route);


--
-- Name: erasure_account_controller_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_account_controller_id ON access.account USING btree (controller_id, route, account_id);


--
-- Name: erasure_account_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_account_operator_account_id ON access.account USING btree (operator_account_id, route, account_id);


--
-- Name: erasure_account_preferences_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_account_preferences_account_id ON access.account_preferences USING btree (account_id, route);


--
-- Name: erasure_agent_page_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_page_account_id ON access.agent_page USING btree (account_id, route, subject_id);


--
-- Name: erasure_agent_verification_request_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_verification_request_account_id ON access.agent_verification_request USING btree (account_id, route, request_id);


--
-- Name: erasure_agent_verification_request_decided_by; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_verification_request_decided_by ON access.agent_verification_request USING btree (decided_by, route, request_id);


--
-- Name: erasure_agent_verification_request_requested_by; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_agent_verification_request_requested_by ON access.agent_verification_request USING btree (requested_by, route, request_id);


--
-- Name: erasure_committed_continuation_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_committed_continuation_account_id ON access.committed_continuation USING btree (account_id, route, continuation_id);


--
-- Name: erasure_committed_continuation_prior_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_committed_continuation_prior_operator_account_id ON access.committed_continuation USING btree (prior_operator_account_id, route, continuation_id);


--
-- Name: erasure_continuation_barrier; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_continuation_barrier ON access.committed_continuation USING btree (route, account_id, barrier_receipt_id);


--
-- Name: erasure_continuation_reservation; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_continuation_reservation ON access.committed_continuation USING btree (route, account_id, prior_reservation_id, prior_operator_account_id);


--
-- Name: erasure_credential_floor_receipt_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_credential_floor_receipt_account_id ON access.credential_floor_receipt USING btree (account_id, route, opening_receipt_id);


--
-- Name: erasure_erasure_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_erasure_account_id ON access.erasure USING btree (account_id, route);


--
-- Name: erasure_erasure_acknowledgement_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_erasure_acknowledgement_account_id ON access.erasure_acknowledgement USING btree (account_id, route, participant);


--
-- Name: erasure_governance_bootstrap_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_governance_bootstrap_account_id ON access.governance_bootstrap USING btree (account_id, route, resource_id);


--
-- Name: erasure_governance_reach_actor_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_governance_reach_actor_account_id ON access.governance_reach USING btree (actor_account_id, route, transaction_id, action, resource_id);


--
-- Name: erasure_governance_reach_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_governance_reach_resource_id ON access.governance_reach USING btree (resource_id, route, transaction_id, action);


--
-- Name: erasure_handle_claim_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_handle_claim_account_id ON access.handle_claim USING btree (account_id, route, normalized_handle);


--
-- Name: erasure_handle_unfinished; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_handle_unfinished ON access.lifecycle_handle_operation USING btree (account_id, route, operation_id) WHERE (state = 'published'::text);


--
-- Name: erasure_late_item_open; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_late_item_open ON access.erasure_late_item USING btree (route, account_id) WHERE (resolved_at IS NULL);


--
-- Name: erasure_lifecycle_coordination_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_coordination_account_id ON access.lifecycle_coordination USING btree (account_id, route, reservation_id);


--
-- Name: erasure_lifecycle_coordination_related_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_coordination_related_account_id ON access.lifecycle_coordination USING btree (related_account_id, route, account_id, reservation_id);


--
-- Name: erasure_lifecycle_fence_receipt_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_fence_receipt_account_id ON access.lifecycle_fence_receipt USING btree (account_id, route, receipt_id);


--
-- Name: erasure_lifecycle_fence_receipt_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_fence_receipt_operator_account_id ON access.lifecycle_fence_receipt USING btree (operator_account_id, route, account_id, receipt_id);


--
-- Name: erasure_lifecycle_fence_receipt_prior_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_fence_receipt_prior_operator_account_id ON access.lifecycle_fence_receipt USING btree (prior_operator_account_id, route, account_id, receipt_id);


--
-- Name: erasure_lifecycle_handle_effect_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_handle_effect_account_id ON access.lifecycle_handle_effect USING btree (account_id, route, normalized_handle, reservation_id, operation_id, effect);


--
-- Name: erasure_lifecycle_handle_operation_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_handle_operation_account_id ON access.lifecycle_handle_operation USING btree (account_id, route, operation_id);


--
-- Name: erasure_lifecycle_membership_slot_member_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_membership_slot_member_account_id ON access.lifecycle_membership_slot USING btree (member_account_id, route, organization_id, reservation_id);


--
-- Name: erasure_lifecycle_membership_slot_organization_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_membership_slot_organization_id ON access.lifecycle_membership_slot USING btree (organization_id, route, member_account_id, reservation_id);


--
-- Name: erasure_lifecycle_registration_expiry_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_lifecycle_registration_expiry_account_id ON access.lifecycle_registration_expiry USING btree (account_id, route, reservation_id);


--
-- Name: erasure_locator_work_open; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_locator_work_open ON access.erasure_locator_work USING btree (opened_at) WHERE ((state <> 'done'::text) AND (state <> 'resolved'::text));


--
-- Name: erasure_member_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_member_id_approval ON access.workflow_approval USING btree (erasure_member_id, route, approval_id);


--
-- Name: erasure_membership_inverse_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_membership_inverse_account_id ON access.membership_inverse USING btree (account_id, route, kind, group_id);


--
-- Name: erasure_membership_inverse_group_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_membership_inverse_group_id ON access.membership_inverse USING btree (group_id, route, account_id, kind);


--
-- Name: erasure_membership_inverse_terminal_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_membership_inverse_terminal_account_id ON access.membership_inverse_terminal USING btree (account_id, route, kind, group_id, reservation_id);


--
-- Name: erasure_membership_inverse_terminal_group_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_membership_inverse_terminal_group_id ON access.membership_inverse_terminal USING btree (group_id, route, account_id, kind, reservation_id);


--
-- Name: erasure_opening_principal; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_opening_principal ON access.operator_opening_receipt USING btree (erasure_principal_id, route, operator_account_id, receipt_id);


--
-- Name: erasure_operator_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_id_approval ON access.workflow_approval USING btree (erasure_operator_id, route, approval_id);


--
-- Name: erasure_operator_opening_receipt_acting_human_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_opening_receipt_acting_human_id ON access.operator_opening_receipt USING btree (acting_human_id, route, operator_account_id, receipt_id);


--
-- Name: erasure_operator_opening_receipt_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_opening_receipt_operator_account_id ON access.operator_opening_receipt USING btree (operator_account_id, route, receipt_id);


--
-- Name: erasure_operator_opening_receipt_subject_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_opening_receipt_subject_account_id ON access.operator_opening_receipt USING btree (subject_account_id, route, operator_account_id, receipt_id);


--
-- Name: erasure_operator_relation_slot_operator_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_relation_slot_operator_account_id ON access.operator_relation_slot USING btree (operator_account_id, route, subject_account_id, reservation_id);


--
-- Name: erasure_operator_relation_slot_subject_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_operator_relation_slot_subject_account_id ON access.operator_relation_slot USING btree (subject_account_id, route, reservation_id);


--
-- Name: erasure_organization_close_organization_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_organization_close_organization_id ON access.organization_close USING btree (organization_id, route);


--
-- Name: erasure_organization_member_member_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_organization_member_member_account_id ON access.organization_member USING btree (member_account_id, route, organization_id, valid);


--
-- Name: erasure_organization_member_organization_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_organization_member_organization_id ON access.organization_member USING btree (organization_id, route, member_account_id, valid);


--
-- Name: erasure_previous_operator_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_previous_operator_id_approval ON access.workflow_approval USING btree (erasure_previous_operator_id, route, approval_id);


--
-- Name: erasure_previous_subject_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_previous_subject_id_approval ON access.workflow_approval USING btree (erasure_previous_subject_id, route, approval_id);


--
-- Name: erasure_principal_assignment_assigned_actor_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_principal_assignment_assigned_actor_id ON access.principal_assignment USING btree (assigned_actor_id, route, principal_id, request_id);


--
-- Name: erasure_principal_assignment_creator_principal_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_principal_assignment_creator_principal_id ON access.principal_assignment USING btree (creator_principal_id, route, principal_id, request_id);


--
-- Name: erasure_principal_assignment_principal_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_principal_assignment_principal_id ON access.principal_assignment USING btree (principal_id, route, request_id);


--
-- Name: erasure_principal_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_principal_id_approval ON access.workflow_approval USING btree (erasure_principal_id, route, approval_id);


--
-- Name: erasure_rating_counter_controller_account_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_rating_counter_controller_account_id ON access.rating_counter_controller USING btree (account_id, route, effective_at);


--
-- Name: erasure_rating_counter_controller_controller_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_rating_counter_controller_controller_id ON access.rating_counter_controller USING btree (controller_id, route, account_id, effective_at);


--
-- Name: erasure_resource_denial_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_denial_resource_id ON access.resource_denial USING btree (resource_id, route, erasure_key);


--
-- Name: erasure_resource_denial_subject_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_denial_subject_id ON access.resource_denial USING btree (subject_id, route, erasure_key);


--
-- Name: erasure_resource_grant_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_grant_resource_id ON access.resource_grant USING btree (resource_id, route, erasure_key);


--
-- Name: erasure_resource_grant_subject_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_grant_subject_id ON access.resource_grant USING btree (subject_id, route, erasure_key) WHERE (subject_kind = 'identity'::text);


--
-- Name: erasure_resource_initialization_creator_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_initialization_creator_id ON access.resource_initialization USING btree (creator_id, route, resource_id);


--
-- Name: erasure_resource_initialization_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_initialization_resource_id ON access.resource_initialization USING btree (resource_id, route);


--
-- Name: erasure_resource_role_grant_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_role_grant_resource_id ON access.resource_role_grant USING btree (resource_id, route, erasure_key);


--
-- Name: erasure_resource_role_grant_subject_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_resource_role_grant_subject_id ON access.resource_role_grant USING btree (subject_id, route, erasure_key) WHERE (subject_kind = 'identity'::text);


--
-- Name: erasure_standing_parent_installation_resource_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_standing_parent_installation_resource_id ON access.standing_parent_installation USING btree (resource_id, route, erasure_key);


--
-- Name: erasure_subject_id_approval; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_subject_id_approval ON access.workflow_approval USING btree (erasure_subject_id, route, approval_id);


--
-- Name: erasure_workflow_approval_actor_id; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_workflow_approval_actor_id ON access.workflow_approval USING btree (actor_id, route, approval_id);


--
-- Name: erasure_write_rate_chunk_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_write_rate_chunk_account ON access.write_rate_chunk USING btree (account_id, route, identity_digest, operation_id, chunk_index);


--
-- Name: erasure_write_rate_counter_account; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX erasure_write_rate_counter_account ON access.write_rate_counter USING btree (account_id, route, identity_digest, family);


--
-- Name: lifecycle_coordination_purpose_page; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX lifecycle_coordination_purpose_page ON access.lifecycle_coordination USING btree (route, account_id, purpose, reservation_id);


--
-- Name: lifecycle_membership_live; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX lifecycle_membership_live ON access.lifecycle_membership_slot USING btree (route, organization_id, member_account_id) WHERE (NOT terminal);


--
-- Name: operator_fence_page_erasure_row; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX operator_fence_page_erasure_row ON access.operator_fence_page USING btree (route, erasure_row_id);


--
-- Name: organization_member_change; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX organization_member_change ON access.organization_member USING btree (route, organization_id, member_account_id, transaction_id);


--
-- Name: organization_member_cleanup; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX organization_member_cleanup ON access.organization_member USING btree (route, organization_id, member_account_id, valid);


--
-- Name: organization_member_next_role; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX organization_member_next_role ON access.organization_member USING btree (route, organization_id, member_account_id, role, lower(valid)) WHERE (NOT lower_inf(valid));


--
-- Name: organization_member_owner_probe; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX organization_member_owner_probe ON access.organization_member USING gist (route, organization_id, valid) WHERE (role = 'owner'::text);


--
-- Name: organization_member_row_key; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX organization_member_row_key ON access.organization_member USING btree (route, organization_id, row_key);


--
-- Name: principal_assignment_speakers; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX principal_assignment_speakers ON access.principal_assignment USING btree (route, principal_id, assigned_actor_id, COALESCE(lower(valid), '-infinity'::timestamp with time zone)) INCLUDE (valid) WHERE (revoked_at IS NULL);


--
-- Name: resource_denial_open; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX resource_denial_open ON access.resource_denial USING btree (route, resource_id, subject_id, subject_role, action, reason) WHERE upper_inf(valid);


--
-- Name: resource_denial_permission; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_denial_permission ON access.resource_denial USING gist (route, resource_id, action, subject_id, subject_role, valid);


--
-- Name: resource_grant_pkey_lookup; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_grant_pkey_lookup ON access.resource_grant USING btree (subject_kind, subject_id, subject_role, action, valid) INCLUDE (route, resource_id) WHERE ((route = 0) AND (resource_id = '00000000-0000-8000-8000-000000000000'::uuid));


--
-- Name: resource_grant_point_lookup; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_grant_point_lookup ON access.resource_grant USING btree (route, resource_id, subject_kind, subject_id, subject_role, action, valid);


--
-- Name: resource_role_grant_open; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX resource_role_grant_open ON access.resource_role_grant USING btree (route, resource_id, subject_kind, subject_id, subject_role, grant_role) WHERE upper_inf(valid);


--
-- Name: resource_role_grant_point_lookup; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX resource_role_grant_point_lookup ON access.resource_role_grant USING btree (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid);

CREATE INDEX realm_owner_continuity ON access.resource_role_grant USING gist (route, resource_id, valid) INCLUDE (subject_id) WHERE ((subject_kind = 'identity'::text) AND (subject_role = ''::text) AND (grant_role = 'community.realm.owner'::text) AND upper_inf(valid));

CREATE INDEX realm_claim_current_owner ON access.resource_role_grant
USING gist (route, resource_id, valid)
WHERE subject_kind = 'identity' AND subject_role = '' AND grant_role = 'community.realm.owner';


--
-- Name: workflow_approval_expiry; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX workflow_approval_expiry ON access.workflow_approval USING btree (route, expires_at, approval_id);


--
-- Name: write_rate_chunk_expiry; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX write_rate_chunk_expiry ON access.write_rate_chunk USING btree (route, expires_at, identity_digest, operation_id, chunk_index);


--
-- Name: write_rate_counter_expiry; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX write_rate_counter_expiry ON access.write_rate_counter USING btree (route, expires_at, identity_digest, family);


--
-- Name: account account_creation_time; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_creation_time BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.guard_account_creation_time();


--
-- Name: account account_identity; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_identity BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.guard_account_identity();


--
-- Name: account account_membership_inverse; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_membership_inverse BEFORE INSERT ON access.account FOR EACH ROW EXECUTE FUNCTION access.initialize_membership_inverse();


--
-- Name: account account_public_change; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_public_change BEFORE INSERT OR UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.record_public_account_change();


--
-- Name: principal_assignment assignment_identity; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER assignment_identity BEFORE INSERT OR UPDATE ON access.principal_assignment FOR EACH ROW EXECUTE FUNCTION access.guard_assignment_identity();


--
-- Name: auth_history_proof auth_history_proof_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER auth_history_proof_immutable BEFORE DELETE OR UPDATE ON access.auth_history_proof FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_completion_immutable();


--
-- Name: committed_continuation_completion committed_continuation_completion_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER committed_continuation_completion_immutable BEFORE DELETE OR UPDATE ON access.committed_continuation_completion FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_completion_immutable();


--
-- Name: committed_continuation_entry committed_continuation_entry_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER committed_continuation_entry_immutable BEFORE DELETE OR UPDATE ON access.committed_continuation_entry FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_completion_immutable();


--
-- Name: committed_continuation committed_continuation_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER committed_continuation_immutable BEFORE UPDATE ON access.committed_continuation FOR EACH ROW EXECUTE FUNCTION access.committed_continuation_immutable();


--
-- Name: resource_role_grant context_directory_owner_dirty; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER context_directory_owner_dirty AFTER INSERT OR DELETE OR UPDATE ON access.resource_role_grant FOR EACH ROW EXECUTE FUNCTION semantic.context_directory_owner_dirty();


--
-- Name: erasure_acknowledgement erasure_acknowledgement_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER erasure_acknowledgement_guard BEFORE DELETE OR UPDATE ON access.erasure_acknowledgement FOR EACH ROW EXECUTE FUNCTION access.guard_erasure_acknowledgement();


--
-- Name: erasure erasure_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER erasure_guard BEFORE DELETE OR UPDATE ON access.erasure FOR EACH ROW EXECUTE FUNCTION access.guard_erasure();


--
-- Name: handle_claim guard_retired_handle; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER guard_retired_handle BEFORE INSERT OR DELETE OR UPDATE ON access.handle_claim FOR EACH ROW EXECUTE FUNCTION access.guard_retired_handle();


--
-- Name: lifecycle_membership_slot lifecycle_membership_terminal_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER lifecycle_membership_terminal_guard BEFORE DELETE OR UPDATE ON access.lifecycle_membership_slot FOR EACH ROW WHEN (old.terminal) EXECUTE FUNCTION access.guard_membership_terminal();


--
-- Name: account lifecycle_responsibility; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER lifecycle_responsibility BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.guard_lifecycle_responsibility();


--
-- Name: membership_inverse membership_inverse_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER membership_inverse_guard BEFORE DELETE OR UPDATE ON access.membership_inverse FOR EACH ROW EXECUTE FUNCTION access.guard_membership_inverse();


--
-- Name: membership_inverse_terminal membership_inverse_terminal_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER membership_inverse_terminal_guard BEFORE DELETE OR UPDATE ON access.membership_inverse_terminal FOR EACH ROW EXECUTE FUNCTION access.guard_membership_terminal();


--
-- Name: committed_continuation native_continuation_delete; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_continuation_delete BEFORE DELETE ON access.committed_continuation FOR EACH ROW EXECUTE FUNCTION access.guard_native_continuation_delete();


--
-- Name: committed_continuation_completion native_erasure_replay; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_replay BEFORE INSERT ON access.committed_continuation_completion FOR EACH ROW EXECUTE FUNCTION access.guard_native_erasure_replay();


--
-- Name: committed_continuation_entry native_erasure_replay; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_replay BEFORE INSERT ON access.committed_continuation_entry FOR EACH ROW EXECUTE FUNCTION access.guard_native_erasure_replay();


--
-- Name: operator_fence_page native_erasure_replay; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_replay BEFORE INSERT ON access.operator_fence_page FOR EACH ROW EXECUTE FUNCTION access.guard_native_erasure_replay();


--
-- Name: committed_continuation native_erasure_roles; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.committed_continuation FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();


--
-- Name: committed_continuation_completion native_erasure_roles; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.committed_continuation_completion FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();


--
-- Name: committed_continuation_entry native_erasure_roles; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.committed_continuation_entry FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();


--
-- Name: operator_fence_page native_erasure_roles; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER native_erasure_roles AFTER INSERT ON access.operator_fence_page FOR EACH ROW EXECUTE FUNCTION access.record_native_continuation_roles();


--
-- Name: operator_fence_page operator_fence_page_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER operator_fence_page_immutable BEFORE DELETE OR UPDATE ON access.operator_fence_page FOR EACH ROW EXECUTE FUNCTION access.operator_fence_page_immutable();


--
-- Name: account operator_relation_version; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER operator_relation_version BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.advance_operator_relation();


--
-- Name: account rating_controller; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER rating_controller AFTER INSERT OR UPDATE OF operator_account_id ON access.account FOR EACH ROW EXECUTE FUNCTION access.record_rating_controller();


--
-- Name: resource_role_grant semantic_resource_role_erasure; Type: TRIGGER; Schema: access; Owner: -
--

CREATE CONSTRAINT TRIGGER semantic_resource_role_erasure AFTER INSERT OR UPDATE ON access.resource_role_grant DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION semantic.capture_resource_role_erasure();


--
-- Name: workflow_approval workflow_approval_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER workflow_approval_immutable BEFORE UPDATE ON access.workflow_approval FOR EACH ROW EXECUTE FUNCTION access.workflow_approval_immutable();


--
-- Name: auth_history_proof auth_history_proof_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.auth_history_proof
    ADD CONSTRAINT auth_history_proof_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: committed_continuation committed_continuation_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.committed_continuation
    ADD CONSTRAINT committed_continuation_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.account(route, account_id);


--
-- Name: erasure_acknowledgement erasure_acknowledgement_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_acknowledgement
    ADD CONSTRAINT erasure_acknowledgement_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: erasure_late_item erasure_late_item_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_late_item
    ADD CONSTRAINT erasure_late_item_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: erasure_native_blocked erasure_native_blocked_progress_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_blocked
    ADD CONSTRAINT erasure_native_blocked_progress_id_fkey FOREIGN KEY (progress_id) REFERENCES access.erasure_native_progress(progress_id);


--
-- Name: erasure_native_consumed_child erasure_native_consumed_child_progress_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_consumed_child
    ADD CONSTRAINT erasure_native_consumed_child_progress_id_fkey FOREIGN KEY (progress_id) REFERENCES access.erasure_native_progress(progress_id);


--
-- Name: erasure_native_progress erasure_native_progress_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_native_progress
    ADD CONSTRAINT erasure_native_progress_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: erasure_progress erasure_progress_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure_progress
    ADD CONSTRAINT erasure_progress_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.erasure(route, account_id);


--
-- Name: erasure erasure_route_account_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure
    ADD CONSTRAINT erasure_route_account_id_fkey FOREIGN KEY (route, account_id) REFERENCES access.account(route, account_id);


--
-- Name: operator_fence_page operator_fence_page_route_continuation_id_fkey; Type: FK CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.operator_fence_page
    ADD CONSTRAINT operator_fence_page_route_continuation_id_fkey FOREIGN KEY (route, continuation_id) REFERENCES access.committed_continuation(route, continuation_id);


--
-- PostgreSQL database dump complete
--



CREATE SEQUENCE access.account_discovery_revision AS bigint NO CYCLE;

CREATE TABLE access.account_discovery_population (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  population bigint NOT NULL CHECK (population >= 0),
  revision bigint NOT NULL,
  claim_revision bigint NOT NULL
);
-- One coalescing source intent per Account key on each native anchor. No public
-- profile/text copies, receipts or history. The worker acknowledges only an exact
-- revision, so a concurrent writer cannot lose a newer obligation.
CREATE TABLE access.account_discovery_intent (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (route, account_id)
);
CREATE INDEX account_discovery_intent_account ON access.account_discovery_intent(account_id, route);
CREATE TABLE access.account_discovery_claim_intent (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (route, account_id)
);
CREATE INDEX account_discovery_claim_intent_account ON access.account_discovery_claim_intent(account_id, route);
CREATE TABLE access.account_discovery_claim_cursor (
  route integer NOT NULL,
  account_id uuid NOT NULL,
  claim_partition integer NOT NULL CHECK (claim_partition BETWEEN 0 AND 4095),
  revision bigint NOT NULL CHECK (revision > 0),
  PRIMARY KEY (route, account_id, claim_partition),
  FOREIGN KEY (route, account_id) REFERENCES access.account(route, account_id) ON DELETE CASCADE
);
CREATE FUNCTION access.account_discovery_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.route, NEW.account_id) IS DISTINCT FROM (OLD.route, OLD.account_id) THEN
    RAISE EXCEPTION 'Account discovery source keys are immutable';
  END IF;
  p := CASE WHEN TG_OP = 'DELETE' THEN OLD.route >> 4 ELSE NEW.route >> 4 END;
  -- Serialize allocation with the native head; a late commit must advance it too.
  PERFORM 1 FROM access.account_discovery_population WHERE partition_no = p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account discovery census is not installed'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.discovery_revision := nextval('access.account_discovery_revision');
  RETURN NEW;
END $$;
CREATE FUNCTION access.account_discovery_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; a uuid; v bigint; delta integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.state = 'active' AND NOT OLD.authn_fenced THEN delta := delta - 1; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.state = 'active' AND NOT NEW.authn_fenced THEN delta := delta + 1; END IF;
    r := NEW.route; a := NEW.account_id; v := NEW.discovery_revision;
  ELSE
    r := OLD.route; a := OLD.account_id; v := nextval('access.account_discovery_revision');
  END IF;
  UPDATE access.account_discovery_population SET population = population + delta, revision = v WHERE partition_no = r >> 4;
  IF TG_OP <> 'UPDATE' OR NOT access.native_terminal_account_ready(OLD) THEN
    INSERT INTO access.account_discovery_intent VALUES (r, a, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  IF TG_OP = 'DELETE' OR NEW.state = 'deleted' THEN
    DELETE FROM access.account_discovery_claim_cursor WHERE route = r AND account_id = a;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER account_discovery_before BEFORE INSERT OR UPDATE OR DELETE ON access.account
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_before();
CREATE TRIGGER account_discovery_after AFTER INSERT OR UPDATE OR DELETE ON access.account
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_after();

CREATE FUNCTION access.account_discovery_claim_before() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.route, NEW.normalized_handle) IS DISTINCT FROM (OLD.route, OLD.normalized_handle) THEN
    RAISE EXCEPTION 'Account discovery claim keys are immutable';
  END IF;
  p := CASE WHEN TG_OP = 'DELETE' THEN OLD.route >> 4 ELSE NEW.route >> 4 END;
  PERFORM 1 FROM access.account_discovery_population WHERE partition_no = p FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account discovery census is not installed'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.discovery_revision := nextval('access.account_discovery_revision');
  RETURN NEW;
END $$;
CREATE FUNCTION access.account_discovery_claim_after() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r integer; v bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD.route; v := nextval('access.account_discovery_revision');
  ELSE r := NEW.route; v := NEW.discovery_revision; END IF;
  UPDATE access.account_discovery_population SET claim_revision = v WHERE partition_no = r >> 4;
  IF TG_OP <> 'INSERT' AND OLD.account_id IS NOT NULL THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, OLD.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.account_id IS NOT NULL THEN
    INSERT INTO access.account_discovery_claim_intent VALUES (r, NEW.account_id, v)
      ON CONFLICT (route, account_id) DO UPDATE SET revision = EXCLUDED.revision;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER account_discovery_claim_before BEFORE INSERT OR UPDATE OR DELETE ON access.handle_claim
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_claim_before();
CREATE TRIGGER account_discovery_claim_after AFTER INSERT OR UPDATE OR DELETE ON access.handle_claim
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_claim_after();

-- Preferences share the Account anchor. All writers, including native internal
-- commands, dirty current summaries through the same source revision hook.
CREATE FUNCTION access.account_discovery_preferences() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE access.account SET discovery_revision = discovery_revision WHERE route = OLD.route AND account_id = OLD.account_id;
  ELSE
    UPDATE access.account SET discovery_revision = discovery_revision WHERE route = NEW.route AND account_id = NEW.account_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER account_discovery_preferences AFTER INSERT OR UPDATE OR DELETE ON access.account_preferences
FOR EACH ROW EXECUTE FUNCTION access.account_discovery_preferences();

-- TRUNCATE is an administrative writer too; preserve sequence high water and
-- invalidate all observations while clearing the finite census in this cut.
CREATE FUNCTION access.account_discovery_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'account' THEN
    UPDATE access.account_discovery_population SET population = 0, revision = nextval('access.account_discovery_revision');
  ELSE
    UPDATE access.account_discovery_population SET claim_revision = nextval('access.account_discovery_revision');
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER account_discovery_truncate AFTER TRUNCATE ON access.account
FOR EACH STATEMENT EXECUTE FUNCTION access.account_discovery_truncate();
CREATE TRIGGER account_discovery_claim_truncate AFTER TRUNCATE ON access.handle_claim
FOR EACH STATEMENT EXECUTE FUNCTION access.account_discovery_truncate();

CREATE TABLE access.realm_membership_transition (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  realm_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  hold_transaction_id uuid NOT NULL,
  legacy boolean NOT NULL DEFAULT false,
  proof_transaction_id uuid,
  outcome text CHECK (outcome IN ('published', 'cancelled')),
  consumed_transaction_id uuid,
  PRIMARY KEY (route, account_id, generation_id),
  UNIQUE (route, account_id, realm_id, operation_id),
  CHECK (route = (get_byte(uuid_send(account_id),10)*256 + get_byte(uuid_send(account_id),11))),
  CHECK ((proof_transaction_id IS NULL) = (outcome IS NULL)),
  CHECK ((proof_transaction_id IS NULL) = (consumed_transaction_id IS NULL))
);
CREATE UNIQUE INDEX realm_membership_transition_open
  ON access.realm_membership_transition (route, account_id, realm_id) WHERE proof_transaction_id IS NULL;
CREATE FUNCTION access.guard_realm_membership_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.proof_transaction_id IS NULL AND NEW.proof_transaction_id IS NOT NULL
    AND NEW.outcome IS NOT NULL AND NEW.consumed_transaction_id IS NOT NULL
    AND (to_jsonb(OLD) - 'proof_transaction_id' - 'outcome' - 'consumed_transaction_id') =
        (to_jsonb(NEW) - 'proof_transaction_id' - 'outcome' - 'consumed_transaction_id')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Realm transition provenance and consumption are immutable' USING ERRCODE = '23514';
END; $$;
CREATE TRIGGER realm_membership_transition_guard BEFORE UPDATE OR DELETE ON access.realm_membership_transition
  FOR EACH ROW EXECUTE FUNCTION access.guard_realm_membership_transition();
CREATE TABLE access.realm_membership_reconciliation (
  route integer NOT NULL, account_id uuid NOT NULL, barrier_id text NOT NULL,
  after_id uuid, completed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (route, account_id, barrier_id)
);
CREATE TABLE access.realm_membership_reconciliation_item (
  route integer NOT NULL, account_id uuid NOT NULL, barrier_id text NOT NULL,
  reservation_id uuid NOT NULL, realm_id uuid NOT NULL, hold_transaction_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('published','cancelled','pending','uncertain')),
  PRIMARY KEY (route, account_id, barrier_id, reservation_id)
);
CREATE INDEX realm_membership_reconciliation_pending ON access.realm_membership_reconciliation_item
 (route, account_id, barrier_id, reservation_id) WHERE state IN ('pending','uncertain');


-- Freeze the install cut and install writer hooks in the same native transaction.
CREATE INDEX resource_role_grant_predecessor ON access.resource_role_grant
  (route, resource_id, subject_kind, subject_id, subject_role, grant_role,
   (COALESCE(lower(valid), '-infinity'::timestamptz))) INCLUDE (valid);

CREATE TABLE access.current_resource_role_install (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  cut bigint NOT NULL, after_key bigint NOT NULL DEFAULT 0,
  initialized_at timestamptz NOT NULL, complete boolean NOT NULL DEFAULT false
);
INSERT INTO access.current_resource_role_install(singleton,cut,initialized_at)
SELECT true, COALESCE(max(erasure_key),0), clock_timestamp() FROM access.resource_role_grant;
CREATE TABLE access.current_resource_role_frontier (
  route integer NOT NULL, resource_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 0, processed_at timestamptz NOT NULL,
  PRIMARY KEY (route,resource_id)
);
CREATE TABLE access.current_resource_role_key (
  route integer NOT NULL, resource_id uuid NOT NULL, grant_role text NOT NULL,
  subject_kind text NOT NULL, subject_id uuid NOT NULL, subject_role text NOT NULL,
  interval_key bigint NOT NULL REFERENCES access.resource_role_grant(erasure_key) ON DELETE CASCADE,
  PRIMARY KEY (route,resource_id,grant_role,subject_kind,subject_id,subject_role,interval_key)
);
-- No copied principal data in the pending temporal work; at most two boundaries per source interval.
CREATE TABLE access.current_resource_role_due (
  route integer NOT NULL, resource_id uuid NOT NULL, due_at timestamptz NOT NULL,
  interval_key bigint NOT NULL REFERENCES access.resource_role_grant(erasure_key) ON DELETE CASCADE,
  PRIMARY KEY (route,resource_id,due_at,interval_key)
);
CREATE INDEX current_resource_role_due_work ON access.current_resource_role_due(due_at,route,resource_id,interval_key);
CREATE INDEX current_resource_role_key_source ON access.current_resource_role_key(interval_key);
CREATE INDEX current_resource_role_due_source ON access.current_resource_role_due(interval_key);

CREATE FUNCTION access.index_current_resource_role(source access.resource_role_grant) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE anchor timestamptz;
BEGIN
  INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
  SELECT source.route,source.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
  ON CONFLICT DO NOTHING;
  UPDATE access.current_resource_role_frontier SET version=version+1
  WHERE route=source.route AND resource_id=source.resource_id RETURNING processed_at INTO STRICT anchor;
  DELETE FROM access.current_resource_role_key WHERE interval_key=source.erasure_key;
  DELETE FROM access.current_resource_role_due WHERE interval_key=source.erasure_key;
  IF source.valid @> anchor THEN
    INSERT INTO access.current_resource_role_key VALUES
      (source.route,source.resource_id,source.grant_role,source.subject_kind,source.subject_id,source.subject_role,source.erasure_key);
  END IF;
  INSERT INTO access.current_resource_role_due
    SELECT source.route,source.resource_id,boundary,source.erasure_key
    FROM (VALUES (lower(source.valid)),(upper(source.valid))) b(boundary)
    WHERE boundary > anchor ON CONFLICT DO NOTHING;
END; $$;
CREATE FUNCTION access.capture_current_resource_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- Even deletion of the final source row advances the native resource version.
    INSERT INTO access.current_resource_role_frontier(route,resource_id,processed_at)
    SELECT OLD.route,OLD.resource_id,initialized_at FROM access.current_resource_role_install WHERE singleton
    ON CONFLICT DO NOTHING;
    UPDATE access.current_resource_role_frontier SET version=version+1
    WHERE route=OLD.route AND resource_id=OLD.resource_id;
    DELETE FROM access.current_resource_role_key WHERE interval_key=OLD.erasure_key;
    DELETE FROM access.current_resource_role_due WHERE interval_key=OLD.erasure_key;
  END IF;
  IF TG_OP <> 'DELETE' THEN PERFORM access.index_current_resource_role(NEW); END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER current_resource_role_writer AFTER INSERT OR UPDATE OR DELETE ON access.resource_role_grant
FOR EACH ROW EXECUTE FUNCTION access.capture_current_resource_role();

-- One bounded default-upkeep transaction: <=100 installation rows OR <=100 due boundaries.
-- Only installation discovers history, using the immutable erasure-key high water captured above.
-- Default work uses database time; an explicit trusted time supports deterministic boundary fixtures.
CREATE FUNCTION access.advance_current_resource_roles(p_at timestamptz DEFAULT clock_timestamp()) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE install access.current_resource_role_install; source access.resource_role_grant;
  item access.current_resource_role_due; anchor timestamptz; touched integer := 0;
BEGIN
  SELECT * INTO STRICT install FROM access.current_resource_role_install WHERE singleton FOR UPDATE;
  IF NOT install.complete THEN
    FOR source IN SELECT * FROM access.resource_role_grant
      WHERE erasure_key > install.after_key AND erasure_key <= install.cut
      ORDER BY erasure_key LIMIT 100 FOR UPDATE
    LOOP
      PERFORM access.index_current_resource_role(source);
      install.after_key := source.erasure_key;
      touched := touched+1;
    END LOOP;
    UPDATE access.current_resource_role_install SET after_key=install.after_key,
      complete=(touched < 100 OR install.after_key=install.cut) WHERE singleton;
    RETURN touched;
  END IF;
  -- Each iteration removes one exact due reference. The index supplies its next start key.
  FOR counter IN 1..100 LOOP
    SELECT * INTO item FROM access.current_resource_role_due WHERE due_at <= p_at
      ORDER BY due_at,route,resource_id,interval_key LIMIT 1;
    EXIT WHEN NOT FOUND;
    SELECT processed_at INTO STRICT anchor FROM access.current_resource_role_frontier
      WHERE route=item.route AND resource_id=item.resource_id FOR UPDATE;
    -- A concurrent source writer may have removed/replaced this boundary before the frontier lock.
    DELETE FROM access.current_resource_role_due WHERE route=item.route AND resource_id=item.resource_id
      AND due_at=item.due_at AND interval_key=item.interval_key;
    IF NOT FOUND THEN CONTINUE; END IF;
    anchor := greatest(anchor,item.due_at);
    DELETE FROM access.current_resource_role_key WHERE interval_key=item.interval_key;
    INSERT INTO access.current_resource_role_key
      SELECT route,resource_id,grant_role,subject_kind,subject_id,subject_role,erasure_key
      FROM access.resource_role_grant WHERE erasure_key=item.interval_key AND valid @> anchor
      ON CONFLICT DO NOTHING;
    UPDATE access.current_resource_role_frontier SET processed_at=anchor,version=version+1
      WHERE route=item.route AND resource_id=item.resource_id;
    touched := touched+1;
  END LOOP;
  RETURN touched;
END; $$;


-- Native Library custody must observe account termination and authentication-floor changes.
CREATE TRIGGER native_source_account_writer AFTER INSERT OR UPDATE OR DELETE ON access.account
  FOR EACH ROW EXECUTE FUNCTION library.advance_native_source_fence();

-- Native Access provenance. A historical row is evidence of an occurrence, never current authority.
CREATE TABLE access.resource_role_provenance (
  route integer NOT NULL, occurrence bigint GENERATED ALWAYS AS IDENTITY,
  resource_id uuid NOT NULL, resource_type text NOT NULL, original_creator uuid NOT NULL,
  account_id uuid NOT NULL, grant_role text NOT NULL, valid tstzrange,
  side text NOT NULL CHECK(side IN ('creator','new','former')),
  grant_transaction uuid, source_transaction uuid NOT NULL,
  context_key bigint,
  delivery text NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','delivered','not-applicable')),
  PRIMARY KEY(route,occurrence),
  CHECK(route BETWEEN 0 AND 65535)
);
CREATE INDEX resource_role_provenance_account ON access.resource_role_provenance(route,account_id,occurrence);
CREATE INDEX resource_role_provenance_delivery ON access.resource_role_provenance(route,occurrence) WHERE delivery='pending';

CREATE FUNCTION access.capture_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r access.resource_role_grant; i access.resource_initialization; native_tx uuid;
BEGIN
 IF TG_OP='DELETE' THEN r:=OLD; ELSE r:=NEW; END IF;
 IF r.subject_kind<>'identity' OR r.subject_role<>'' THEN RETURN r; END IF;
 SELECT * INTO i FROM access.resource_initialization WHERE route=r.route AND resource_id=r.resource_id;
 IF NOT FOUND THEN RETURN r; END IF;
 native_tx:=coalesce(nullif(current_setting('access.role_native_transaction',true),'' )::uuid,r.transaction_id);
 INSERT INTO access.resource_role_provenance(route,resource_id,resource_type,original_creator,account_id,
   grant_role,valid,side,grant_transaction,source_transaction)
 VALUES(r.route,r.resource_id,i.resource_type,i.creator_id,r.subject_id,r.grant_role,r.valid,
   CASE WHEN TG_OP='DELETE' THEN 'former' ELSE 'new' END,r.transaction_id,native_tx);
 RETURN r;
END; $$;
CREATE FUNCTION access.lock_resource_role_provenance(p_route integer,p_occurrence bigint)
 RETURNS SETOF access.resource_role_provenance LANGUAGE plpgsql AS $$
DECLARE source access.resource_role_provenance;
BEGIN
 IF p_route IS NULL OR p_route NOT BETWEEN 0 AND 65535 OR p_occurrence IS NULL OR p_occurrence<=0 THEN
   RAISE EXCEPTION 'Invalid native role occurrence key' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM core.partition WHERE partition_no=p_route/16 AND write_state='active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Native Context home unavailable' USING ERRCODE='40001'; END IF;
 SELECT * INTO source FROM access.resource_role_provenance
   WHERE route=p_route AND occurrence=p_occurrence FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 IF source.route<>(get_byte(uuid_send(source.resource_id),10)*256+get_byte(uuid_send(source.resource_id),11))
    OR source.source_transaction='00000000-0000-0000-0000-000000000000'::uuid
    OR (source.side='creator' AND (source.account_id<>source.original_creator OR source.grant_role<>''
        OR source.grant_transaction IS NOT NULL OR source.valid IS NOT NULL))
    OR (source.side IN ('new','former') AND (source.grant_transaction IS NULL OR source.valid IS NULL)) THEN
   RAISE EXCEPTION 'Invalid native role occurrence provenance' USING ERRCODE='23514';
 END IF;
 RETURN NEXT source;
END; $$;

CREATE FUNCTION access.guard_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE enrolled record;
BEGIN
 IF ROW(NEW.route,NEW.occurrence,NEW.resource_id,NEW.resource_type,NEW.original_creator,NEW.account_id,
        NEW.grant_role,NEW.valid,NEW.side,NEW.grant_transaction,NEW.source_transaction)
    IS DISTINCT FROM
    ROW(OLD.route,OLD.occurrence,OLD.resource_id,OLD.resource_type,OLD.original_creator,OLD.account_id,
        OLD.grant_role,OLD.valid,OLD.side,OLD.grant_transaction,OLD.source_transaction) THEN
   RAISE EXCEPTION 'Native role occurrence metadata is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.resource_type='semantic.context' AND
    (NEW.context_key IS DISTINCT FROM OLD.context_key OR NEW.delivery IS DISTINCT FROM OLD.delivery) THEN
   IF OLD.delivery<>'pending' OR NEW.delivery='pending' THEN
     RAISE EXCEPTION 'Invalid native Context delivery transition' USING ERRCODE='23514';
   END IF;
   -- Re-run the real, idempotent Source port rather than trusting a supplied result/key.
   -- This also protects direct SQL updates without reading any Source-owned table.
   IF to_regprocedure('semantic.enroll_context_role_provenance(integer,bigint,uuid,uuid,uuid,text,text,text,uuid,uuid)') IS NULL THEN
     RAISE EXCEPTION 'Context historical-party receiver unavailable' USING ERRCODE='23514';
   END IF;
   SELECT * INTO enrolled FROM semantic.enroll_context_role_provenance(
     OLD.route,OLD.occurrence,OLD.resource_id,OLD.original_creator,OLD.account_id,OLD.grant_role,
     OLD.valid::text,OLD.side,OLD.grant_transaction,OLD.source_transaction);
   IF NOT FOUND THEN
     RAISE EXCEPTION 'Context historical-party enrollment unresolved' USING ERRCODE='23514';
   END IF;
   IF NOT coalesce(
     (NEW.delivery='delivered' AND enrolled.state='enrolled' AND enrolled.context_key>0
       AND NEW.context_key=enrolled.context_key)
     OR (NEW.delivery='not-applicable' AND enrolled.state='not-applicable' AND NEW.context_key IS NULL),false) THEN
     RAISE EXCEPTION 'Context delivery requires actual native Source enrollment' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;

CREATE TRIGGER resource_role_provenance_immutable BEFORE UPDATE ON access.resource_role_provenance
 FOR EACH ROW EXECUTE FUNCTION access.guard_resource_role_provenance();

CREATE FUNCTION access.try_deliver_resource_role_provenance(p_route integer,p_occurrence bigint)
 RETURNS text LANGUAGE plpgsql AS $$
DECLARE source access.resource_role_provenance; enrolled record;
BEGIN
 SELECT * INTO source FROM access.lock_resource_role_provenance(p_route,p_occurrence);
 IF NOT FOUND THEN RETURN 'missing'; END IF;
 IF source.delivery<>'pending' THEN RETURN source.delivery; END IF;
 IF source.resource_type='semantic.context' THEN
   IF to_regprocedure('semantic.enroll_context_role_provenance(integer,bigint,uuid,uuid,uuid,text,text,text,uuid,uuid)') IS NULL THEN
     RETURN 'receiver-unavailable';
   END IF;
   -- At the original deferred trigger the executor has already written its genuine
   -- editorial basis. No setting or made-up Source commit substitutes for that basis.
   SELECT * INTO enrolled FROM semantic.enroll_context_role_provenance(
     source.route,source.occurrence,source.resource_id,source.original_creator,source.account_id,source.grant_role,
     source.valid::text,source.side,source.grant_transaction,source.source_transaction);
   IF NOT FOUND THEN RETURN 'pending'; END IF;
   IF enrolled.state='pending' THEN RETURN 'pending'; END IF;
   IF enrolled.state='enrolled' AND enrolled.context_key>0 THEN
     UPDATE access.resource_role_provenance SET delivery='delivered',context_key=enrolled.context_key
       WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
     RETURN 'delivered';
   ELSIF enrolled.state='not-applicable' THEN
     UPDATE access.resource_role_provenance SET delivery='not-applicable',context_key=NULL
       WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
     RETURN 'not-applicable';
   END IF;
   RAISE EXCEPTION 'Invalid native Context enrollment result' USING ERRCODE='23514';
 END IF;
 UPDATE access.resource_role_provenance SET delivery='not-applicable'
   WHERE route=source.route AND occurrence=source.occurrence AND delivery='pending';
 RETURN 'not-applicable';
END; $$;

CREATE FUNCTION access.deliver_resource_role_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM access.try_deliver_resource_role_provenance(NEW.route,NEW.occurrence);
 RETURN NEW;
END; $$;

-- Capture OLD before its destructive removal, and NEW after its authoritative insert.
CREATE TRIGGER resource_role_provenance_old BEFORE DELETE ON access.resource_role_grant
 FOR EACH ROW EXECUTE FUNCTION access.capture_resource_role_provenance();
CREATE TRIGGER resource_role_provenance_new AFTER INSERT ON access.resource_role_grant
 FOR EACH ROW EXECUTE FUNCTION access.capture_resource_role_provenance();
-- Delivery observes the command's actual committed envelope position, after its fence writes.
CREATE CONSTRAINT TRIGGER resource_role_provenance_deliver AFTER INSERT ON access.resource_role_provenance
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.deliver_resource_role_provenance();

-- Native work locators and decisions, never a second grant/owner authority.
CREATE TABLE access.realm_erasure_succession (
  route integer NOT NULL,
  resource_id uuid NOT NULL,
  account_id uuid NOT NULL,
  source_route integer NOT NULL,
  source_version integer NOT NULL CHECK (source_version > 0),
  source_at timestamptz NOT NULL,
  frontier jsonb,
  cursor_role text,
  cursor_kind text,
  cursor_subject_id uuid,
  cursor_subject_role text,
  cursor_interval_key bigint,
  best_account_id uuid,
  best_role text,
  best_valid tstzrange,
  best_interval_key bigint,
  decision_state text CHECK (decision_state IN ('owned', 'orphaned')),
  decision_operation_id uuid,
  decided_at timestamptz,
  PRIMARY KEY (route, resource_id, account_id),
  CHECK (route = (get_byte(uuid_send(resource_id),10)*256+get_byte(uuid_send(resource_id),11))),
  CHECK (source_route = (get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))),
  CHECK ((decision_state IS NULL) = (decision_operation_id IS NULL)),
  CHECK ((decision_state IS NULL) = (decided_at IS NULL)),
  CHECK (decision_state IS DISTINCT FROM 'owned' OR best_account_id IS NOT NULL),
  CHECK (decision_state IS DISTINCT FROM 'orphaned' OR best_account_id IS NULL)
);
CREATE INDEX realm_erasure_succession_account ON access.realm_erasure_succession(account_id,route,resource_id);
CREATE INDEX realm_erasure_succession_candidate ON access.realm_erasure_succession(best_account_id,route,resource_id,account_id)
  WHERE best_account_id IS NOT NULL;
CREATE INDEX realm_erasure_succession_cursor ON access.realm_erasure_succession(cursor_subject_id,route,resource_id,account_id)
  WHERE cursor_subject_id IS NOT NULL;

CREATE FUNCTION access.guard_realm_erasure_succession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Realm succession source custody has no consumer closure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route,NEW.resource_id,NEW.account_id,NEW.source_route,NEW.source_version,NEW.source_at)
       IS DISTINCT FROM ROW(OLD.route,OLD.resource_id,OLD.account_id,OLD.source_route,OLD.source_version,OLD.source_at)
     OR (OLD.decision_state IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Realm succession source and terminal decision are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER realm_erasure_succession_custody BEFORE UPDATE OR DELETE ON access.realm_erasure_succession
  FOR EACH ROW EXECUTE FUNCTION access.guard_realm_erasure_succession();

-- Retain the exact Content-owned source episode with the native decision.
-- Null source fields identify older, unbound work; they never prove application.
ALTER TABLE access.realm_erasure_succession
  ADD COLUMN source_ownership_state text CHECK (source_ownership_state IN ('owned','orphaned')),
  ADD COLUMN source_orphaned_at timestamptz,
  ADD COLUMN source_claim_eligible_at timestamptz,
  ADD COLUMN result_orphaned_at timestamptz,
  ADD COLUMN result_claim_eligible_at timestamptz,
  ADD CONSTRAINT realm_erasure_succession_source_episode CHECK (
    source_ownership_state IS NULL OR
    (source_ownership_state='owned' AND source_orphaned_at IS NULL AND source_claim_eligible_at IS NULL) OR
    (source_ownership_state='orphaned' AND source_orphaned_at IS NOT NULL AND
      source_claim_eligible_at IS NOT NULL AND
      source_claim_eligible_at=source_orphaned_at+interval '720 hours')
  ),
  ADD CONSTRAINT realm_erasure_succession_result_episode CHECK (
    source_ownership_state IS NULL OR
    (decision_state IS DISTINCT FROM 'orphaned' AND
      result_orphaned_at IS NULL AND result_claim_eligible_at IS NULL) OR
    (decision_state='orphaned' AND result_orphaned_at IS NOT NULL AND
      result_claim_eligible_at IS NOT NULL AND
      result_orphaned_at=COALESCE(source_orphaned_at,source_at) AND
      result_claim_eligible_at=result_orphaned_at+interval '720 hours')
  );

CREATE OR REPLACE FUNCTION access.guard_realm_erasure_succession() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Realm succession source custody has no consumer closure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route,NEW.resource_id,NEW.account_id,NEW.source_route,NEW.source_version,NEW.source_at,
         NEW.source_ownership_state,NEW.source_orphaned_at,NEW.source_claim_eligible_at)
       IS DISTINCT FROM ROW(OLD.route,OLD.resource_id,OLD.account_id,OLD.source_route,OLD.source_version,OLD.source_at,
         OLD.source_ownership_state,OLD.source_orphaned_at,OLD.source_claim_eligible_at)
     OR (OLD.decision_state IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Realm succession source and terminal decision are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$;

CREATE TABLE access.agent_identity_intent (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    direction text NOT NULL CHECK (direction IN ('account-agent.verify','account-agent.unverify')),
    receipt_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    account_kind text NOT NULL CHECK (account_kind IN ('actor','organization')),
    catalogue_id uuid NOT NULL,
    request_id uuid,
    requested_by uuid,
    decided_by uuid,
    decision_route integer,
    decision_receipt_id uuid,
    decision_epoch integer,
    decision_position bigint,
    decision_transaction_id uuid,
    pending_receipt_id uuid NOT NULL,
    verification_receipt_id uuid,
    disposition text CHECK (disposition IN ('released','revoked')),
    reason text CHECK (char_length(reason)<=500),
    release text NOT NULL,
    intent jsonb NOT NULL,
    intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL CHECK (source_epoch>0),
    source_position bigint NOT NULL CHECK (source_position>0),
    source_transaction_id uuid NOT NULL,
    undo_job_id uuid,
    undo_job_epoch bigint,
    delivery_key text NOT NULL,
    workflow_id text NOT NULL,
    native_command_kind text NOT NULL,
    native_receipt_key text NOT NULL,
    CHECK ((direction='account-agent.verify' AND native_command_kind='access.agent-verification.pending')
        OR (direction='account-agent.unverify' AND native_command_kind IN
          ('access.agent-verification.released','access.agent-verification.revoked','access.agent-verification.deleted'))),
    minimized boolean NOT NULL DEFAULT false,
    PRIMARY KEY(route,account_id,direction,receipt_id),
    CHECK (route = get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)),
    CHECK (source_partition = route / 16),
    CHECK ((direction='account-agent.verify' AND request_id IS NOT NULL AND decision_route=0
            AND decision_receipt_id=receipt_id AND decision_epoch>0 AND decision_position>0
            AND decision_transaction_id=receipt_id AND verification_receipt_id IS NULL
            AND undo_job_id IS NULL AND undo_job_epoch IS NULL AND disposition IS NULL)
        OR (direction='account-agent.unverify' AND verification_receipt_id IS NOT NULL
            AND source_transaction_id=receipt_id AND disposition IS NOT NULL
            AND undo_job_id IS NOT NULL AND undo_job_epoch>0)),
    CHECK (direction<>'account-agent.verify' OR source_transaction_id=pending_receipt_id)
);
CREATE INDEX erasure_agent_identity_intent_account_id ON access.agent_identity_intent
    (account_id,route,direction,receipt_id);
CREATE INDEX erasure_agent_identity_intent_requested_by ON access.agent_identity_intent
    (requested_by,route,account_id,direction,receipt_id);
CREATE INDEX erasure_agent_identity_intent_decided_by ON access.agent_identity_intent
    (decided_by,route,account_id,direction,receipt_id);

CREATE FUNCTION access.validate_agent_identity_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.minimized OR NEW.requested_by IS NULL OR
       (NOT EXISTS (SELECT 1 FROM core.receipt r
          WHERE r.partition_no=NEW.source_partition AND r.principal_kind='account'
            AND r.principal_id=NEW.requested_by AND r.command_kind=NEW.native_command_kind
            AND r.idempotency_key=NEW.native_receipt_key
            AND r.transaction_id=NEW.source_transaction_id AND r.epoch=NEW.source_epoch
            AND r.position=NEW.source_position AND r.xmin::text=pg_current_xact_id()::text)
        AND NOT access.agent_identity_recovery_valid(NEW)) THEN
        RAISE EXCEPTION 'Account identity intent lacks original same-command native receipt or verified native recovery' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER agent_identity_intent_native_commit AFTER INSERT ON access.agent_identity_intent
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.validate_agent_identity_intent();

-- Keep source proof until a consumer-aware owner minimizer supplies receiving custody.
CREATE FUNCTION access.guard_agent_identity_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'Account identity source requires receiving erasure custody';
    END IF;
    RAISE EXCEPTION 'Immutable account identity source';
END;
$$;
CREATE TRIGGER agent_identity_intent_immutable BEFORE UPDATE OR DELETE ON access.agent_identity_intent
    FOR EACH ROW EXECUTE FUNCTION access.guard_agent_identity_intent();

CREATE UNIQUE INDEX agent_identity_decision_original ON access.agent_verification_request
 (route,account_id,decision_receipt_id) WHERE decision_receipt_id IS NOT NULL;

CREATE TABLE access.agent_identity_recovery (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    direction text NOT NULL CHECK (direction='account-agent.unverify'),
    receipt_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    decided_by uuid,
    source_partition integer NOT NULL CHECK (source_partition=route/16),
    source_epoch integer NOT NULL CHECK (source_epoch>0),
    source_position bigint NOT NULL CHECK (source_position>0),
    source_transaction_id uuid NOT NULL CHECK (source_transaction_id=receipt_id),
    intent_digest text NOT NULL CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
    verification_intent_digest text NOT NULL CHECK (verification_intent_digest ~ '^[0-9a-f]{64}$'),
    recovery_transaction_id uuid NOT NULL CHECK (recovery_transaction_id<>source_transaction_id),
    recovery_epoch integer NOT NULL CHECK (recovery_epoch=source_epoch),
    recovery_position bigint NOT NULL CHECK (recovery_position>source_position),
    recovery_receipt_key text NOT NULL,
    PRIMARY KEY(route,account_id,direction,receipt_id),
    FOREIGN KEY(route,account_id,direction,receipt_id)
      REFERENCES access.agent_identity_intent(route,account_id,direction,receipt_id),
    CHECK (route=get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11))
);
CREATE INDEX erasure_agent_identity_recovery_account_id ON access.agent_identity_recovery
 (account_id,route,direction,receipt_id);
CREATE INDEX erasure_agent_identity_recovery_requested_by ON access.agent_identity_recovery
 (requested_by,route,account_id,direction,receipt_id);
CREATE INDEX erasure_agent_identity_recovery_decided_by ON access.agent_identity_recovery
 (decided_by,route,account_id,direction,receipt_id);

-- An association alone is DATA. Both the retained original and this actual recovery command must exist.
-- The native released undo reader additionally verifies publication before this command is entered.
CREATE FUNCTION access.agent_identity_recovery_valid(i access.agent_identity_intent) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM access.agent_identity_recovery a
  JOIN core.receipt r ON r.partition_no=a.source_partition AND r.principal_kind='account'
    AND r.principal_id=a.requested_by AND r.command_kind=i.native_command_kind
    AND r.idempotency_key=i.native_receipt_key AND r.transaction_id=a.source_transaction_id
    AND r.epoch=a.source_epoch AND r.position=a.source_position AND r.payload_state='present'
    AND r.xmin::text<>pg_current_xact_id()::text
  JOIN core.receipt c ON c.partition_no=a.source_partition AND c.principal_kind='account'
    AND c.principal_id=a.requested_by AND c.command_kind='access.agent-identity.recover'
    AND c.idempotency_key=a.recovery_receipt_key
    AND c.transaction_id=a.recovery_transaction_id AND c.epoch=a.recovery_epoch
    AND c.position=a.recovery_position AND c.xmin::text=pg_current_xact_id()::text
    AND c.payload_state='present'
    AND c.request_digest=sha256(convert_to(format('[%s,%s,%s,%s,%s,%s]',
      to_json(i.delivery_key),to_json(i.source_transaction_id::text),i.source_epoch,
      to_json(i.source_position::text),to_json(i.intent_digest),to_json(a.verification_intent_digest)), 'UTF8'))
  JOIN core.partition p ON p.partition_no=a.source_partition AND p.write_state='active'
    AND p.epoch=a.source_epoch AND p.position>=a.recovery_position
  JOIN access.agent_identity_intent v ON v.route=i.route AND v.account_id=i.account_id
    AND v.direction='account-agent.verify' AND v.receipt_id=i.verification_receipt_id
    AND v.intent_digest=a.verification_intent_digest AND NOT v.minimized
    AND v.xmin::text<>pg_current_xact_id()::text
    AND v.source_epoch=i.source_epoch AND v.catalogue_id=i.catalogue_id
    AND v.source_position<r.position
    AND v.agent_id=i.agent_id AND v.account_kind=i.account_kind AND v.release=i.release
  WHERE (a.route,a.account_id,a.direction,a.receipt_id)=(i.route,i.account_id,i.direction,i.receipt_id)
    AND a.xmin::text=pg_current_xact_id()::text
    AND a.requested_by=i.requested_by AND a.decided_by IS NOT DISTINCT FROM i.decided_by
    AND a.source_partition=i.source_partition AND a.source_epoch=i.source_epoch
    AND a.source_position=i.source_position AND a.source_transaction_id=i.source_transaction_id
    AND a.intent_digest=i.intent_digest AND NOT i.minimized
    AND i.direction='account-agent.unverify' AND i.pending_receipt_id=i.receipt_id
    AND i.request_id IS NULL AND i.decision_route IS NULL AND i.decision_receipt_id IS NULL
    AND i.decision_epoch IS NULL AND i.decision_position IS NULL AND i.decision_transaction_id IS NULL
    AND i.delivery_key=format('["%s","%s","%s"]',i.direction,i.account_id::text,i.receipt_id::text)
    AND i.workflow_id='accounts.agent-verification-reversal:'||i.account_id::text||':'||i.receipt_id::text
    AND i.intent=jsonb_build_object('kind','unmerge','original',i.agent_id::text,
      'undoJob',jsonb_build_object('jobId',i.undo_job_id::text,'epoch',i.undo_job_epoch::text),
      'verificationReceipt',i.verification_receipt_id::text,'release',v.release)
    AND i.intent_digest=encode(sha256(convert_to(format(
      '[{"kind":"unmerge","original":%s,"release":%s,"undoJob":{"epoch":%s,"jobId":%s},"verificationReceipt":%s},{"account":%s,"kind":"account-agent.unverify","receipt":%s}]',
      to_json(i.agent_id::text),to_json(i.release),to_json(i.undo_job_epoch::text),to_json(i.undo_job_id::text),
      to_json(i.verification_receipt_id::text),to_json(i.account_id::text),to_json(i.receipt_id::text)), 'UTF8')), 'hex')
    AND r.response=jsonb_build_object('accountId',i.account_id::text,'receiptId',i.receipt_id::text,
      'requestedBy',i.requested_by::text,'kind',i.disposition,'reason',i.reason,
      'catalogueSubjectId',i.catalogue_id::text,'verificationReceiptId',i.verification_receipt_id::text)
    AND i.decided_by IS NOT DISTINCT FROM CASE WHEN i.disposition='revoked' THEN i.requested_by END
    AND ((r.command_kind='access.agent-verification.deleted' AND i.disposition='revoked'
       AND i.reason='Account deleted' AND i.requested_by=i.account_id
       AND r.request_digest=sha256(convert_to(i.account_id::text,'UTF8'))
       AND EXISTS (SELECT 1 FROM access.account t WHERE t.route=i.route AND t.account_id=i.account_id
         AND t.state='deleted'))
     OR (r.command_kind='access.agent-verification.'||i.disposition AND EXISTS (
       SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=r.partition_no
         AND b.transaction_id=r.transaction_id AND b.principal_kind='account' AND b.principal_id=r.principal_id
         AND b.epoch=r.epoch AND b.position=r.position)))
 );
$$;

CREATE FUNCTION access.validate_agent_identity_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i access.agent_identity_intent;
BEGIN
    SELECT * INTO i FROM access.agent_identity_intent
      WHERE (route,account_id,direction,receipt_id)=(NEW.route,NEW.account_id,NEW.direction,NEW.receipt_id);
    IF NOT access.agent_identity_recovery_valid(i) THEN
        RAISE EXCEPTION 'Account identity recovery lacks genuine original and actual recovery custody' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER agent_identity_recovery_native_commit AFTER INSERT ON access.agent_identity_recovery
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.validate_agent_identity_recovery();
CREATE TRIGGER agent_identity_recovery_immutable BEFORE UPDATE OR DELETE ON access.agent_identity_recovery
 FOR EACH ROW EXECUTE FUNCTION access.guard_agent_identity_intent();


-- Native Auth erasure obligation feed.
-- Installation does not scan or rewrite the historical erasure domain. The partial
-- index is drained in batches of 48 under the same partition fence as live capture.
ALTER TABLE access.erasure ADD COLUMN auth_obligation_indexed boolean NOT NULL DEFAULT false;
CREATE INDEX auth_erasure_bootstrap ON access.erasure(route,account_id) WHERE NOT auth_obligation_indexed;
CREATE INDEX auth_erasure_original_floor ON access.lifecycle_fence_receipt(route,account_id,kind)
 INCLUDE(receipt_id,minimum_authn_epoch,transaction_id) WHERE kind='tombstone';

CREATE TABLE access.auth_erasure_source (
 partition_no integer PRIMARY KEY CHECK(partition_no BETWEEN 0 AND 4095),
 generation uuid NOT NULL DEFAULT gen_random_uuid(),
 source_epoch integer NOT NULL CHECK(source_epoch>0),
 source_owner text NOT NULL,
 head bigint NOT NULL DEFAULT 0 CHECK(head>=0),
 initialized boolean NOT NULL DEFAULT false
);
CREATE TABLE access.auth_erasure_obligation (
 partition_no integer NOT NULL CHECK(partition_no=route/16),
 ordinal bigint NOT NULL CHECK(ordinal>0),
 route integer NOT NULL,
 account_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 at timestamptz NOT NULL,
 minimum_authn_epoch bigint CHECK(minimum_authn_epoch>0),
 receipt_id uuid,
 PRIMARY KEY(partition_no,ordinal),
 UNIQUE(route,account_id),
 FOREIGN KEY(route,account_id) REFERENCES access.erasure(route,account_id),
 CHECK((minimum_authn_epoch IS NULL)=(receipt_id IS NULL))
);
CREATE INDEX auth_erasure_pending ON access.auth_erasure_obligation(partition_no,ordinal)
 WHERE minimum_authn_epoch IS NULL;
CREATE TABLE access.auth_erasure_cut (
 cut_id uuid PRIMARY KEY,
 participant text NOT NULL DEFAULT 'auth' CHECK(participant='auth'),
 inventory_version integer NOT NULL DEFAULT 1 CHECK(inventory_version=1),
 producer_version integer NOT NULL DEFAULT 1 CHECK(producer_version=1),
 sealed_partitions integer NOT NULL DEFAULT 0 CHECK(sealed_partitions BETWEEN 0 AND 4096)
);
CREATE TABLE access.auth_erasure_cut_partition (
 cut_id uuid NOT NULL REFERENCES access.auth_erasure_cut,
 partition_no integer NOT NULL REFERENCES access.auth_erasure_source,
 generation uuid NOT NULL,
 source_epoch integer NOT NULL,
 source_owner text NOT NULL,
 source_position bigint NOT NULL CHECK(source_position>=0),
 high_water bigint NOT NULL CHECK(high_water>=0),
 PRIMARY KEY(cut_id,partition_no)
);
CREATE FUNCTION access.auth_erasure_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Auth erasure source evidence is permanent and immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER auth_erasure_obligation_immutable BEFORE UPDATE OR DELETE ON access.auth_erasure_obligation
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();
CREATE TRIGGER auth_erasure_cut_partition_immutable BEFORE UPDATE OR DELETE ON access.auth_erasure_cut_partition
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_immutable();
CREATE FUNCTION access.auth_erasure_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth erasure source is permanent'; END IF;
 IF (NEW.partition_no,NEW.generation,NEW.source_epoch,NEW.source_owner)
    IS DISTINCT FROM (OLD.partition_no,OLD.generation,OLD.source_epoch,OLD.source_owner)
    OR NEW.head<OLD.head OR (OLD.initialized AND NOT NEW.initialized) THEN
  RAISE EXCEPTION 'Auth erasure source cannot change lineage or regress' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER auth_erasure_source_guard BEFORE UPDATE OR DELETE ON access.auth_erasure_source
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_source_guard();
CREATE FUNCTION access.auth_erasure_cut_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Auth erasure cut is permanent'; END IF;
 IF (NEW.cut_id,NEW.participant,NEW.inventory_version,NEW.producer_version)
    IS DISTINCT FROM (OLD.cut_id,OLD.participant,OLD.inventory_version,OLD.producer_version)
    OR NEW.sealed_partitions<>OLD.sealed_partitions+1
    OR NOT EXISTS(SELECT 1 FROM access.auth_erasure_cut_partition
                  WHERE cut_id=OLD.cut_id AND partition_no=OLD.sealed_partitions) THEN
  RAISE EXCEPTION 'Auth erasure cut must advance by one retained native partition' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER auth_erasure_cut_guard BEFORE UPDATE OR DELETE ON access.auth_erasure_cut
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_cut_guard();

-- The existing native routing row serializes bootstrap, writers and cut capture.
-- There is no global erasure counter or new command/coordinator authority.
CREATE FUNCTION access.lock_auth_erasure_source(p integer,require_lineage boolean DEFAULT true) RETURNS access.auth_erasure_source
 LANGUAGE plpgsql AS $$
DECLARE home core.partition; source access.auth_erasure_source;
BEGIN
 SELECT * INTO home FROM core.partition WHERE partition_no=p AND p BETWEEN 0 AND 4095 FOR UPDATE;
 IF NOT FOUND OR home.write_state<>'active' THEN
  RAISE EXCEPTION 'Auth erasure source home unavailable' USING ERRCODE='40001';
 END IF;
 INSERT INTO access.auth_erasure_source(partition_no,source_epoch,source_owner)
 VALUES(p,home.epoch,home.node) ON CONFLICT DO NOTHING;
 SELECT * INTO source FROM access.auth_erasure_source WHERE partition_no=p FOR UPDATE;
 IF require_lineage AND (source.source_epoch<>home.epoch OR source.source_owner<>home.node) THEN
  RAISE EXCEPTION 'Auth erasure source lineage recovery required' USING ERRCODE='40001';
 END IF;
 RETURN source;
END; $$;

CREATE FUNCTION access.capture_auth_erasure_obligation(r integer,a uuid,native boolean) RETURNS void
 LANGUAGE plpgsql AS $$
DECLARE source access.auth_erasure_source; root access.erasure; terminal access.account;
 original access.lifecycle_fence_receipt; candidate access.lifecycle_fence_receipt; found_count integer:=0;
BEGIN
 -- Even while source lineage recovery is pending, current native deletion still
 -- commits and retains its exact obligation in the same ordinal feed. It cannot
 -- relabel the old source epoch or release a stale cut.
 source:=access.lock_auth_erasure_source(r/16,NOT native);
 SELECT * INTO root FROM access.erasure WHERE route=r AND account_id=a FOR UPDATE;
 IF NOT FOUND OR root.auth_obligation_indexed THEN RETURN; END IF;
 SELECT * INTO terminal FROM access.account WHERE route=r AND account_id=a;
 -- A receipt's original native tombstone kind is retained independently of the
 -- mutable current floor. Never infer the original floor from terminal or T.
 FOR candidate IN SELECT * FROM access.lifecycle_fence_receipt
  WHERE route=r AND account_id=a AND kind='tombstone' LIMIT 2
 LOOP
  found_count:=found_count+1; original:=candidate;
 END LOOP;
 IF found_count<>1 OR terminal.state<>'deleted' OR NOT terminal.authn_fenced
    OR terminal.minimum_authn_epoch<original.minimum_authn_epoch THEN
  original.minimum_authn_epoch:=NULL; original.receipt_id:=NULL;
 ELSIF native THEN
  -- New native capture must belong to the actual tombstone transaction, not a
  -- later read/relabel of the current floor or a fabricated old receipt.
  IF NOT EXISTS(SELECT 1 FROM access.lifecycle_fence_receipt f
     WHERE f.route=r AND f.account_id=a AND f.receipt_id=original.receipt_id
       AND f.transaction_id=terminal.transaction_id AND f.xmin::text=pg_current_xact_id()::text)
     OR terminal.fence_receipt_id<>original.receipt_id THEN
   original.minimum_authn_epoch:=NULL; original.receipt_id:=NULL;
  END IF;
 END IF;
 UPDATE access.auth_erasure_source SET head=head+1 WHERE partition_no=r/16 RETURNING * INTO source;
 INSERT INTO access.auth_erasure_obligation(partition_no,ordinal,route,account_id,version,at,minimum_authn_epoch,receipt_id)
 VALUES(r/16,source.head,r,a,root.version,root.at,original.minimum_authn_epoch,original.receipt_id);
 UPDATE access.erasure SET auth_obligation_indexed=true WHERE route=r AND account_id=a;
END; $$;
CREATE FUNCTION access.auth_erasure_producer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM access.capture_auth_erasure_obligation(NEW.route,NEW.account_id,true);
 RETURN NEW;
END; $$;
-- Deferred capture also sees the original fence receipt in the native lifecycle
-- transaction. It runs before COMMIT can expose the permanent erasure to Auth.
CREATE CONSTRAINT TRIGGER auth_erasure_producer AFTER INSERT ON access.erasure
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_producer();
CREATE FUNCTION access.auth_erasure_index_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (TG_OP='UPDATE' AND OLD.auth_obligation_indexed AND NOT NEW.auth_obligation_indexed)
    OR (NEW.auth_obligation_indexed AND NOT EXISTS(
      SELECT 1 FROM access.auth_erasure_obligation WHERE route=NEW.route AND account_id=NEW.account_id)) THEN
  RAISE EXCEPTION 'Auth erasure index cannot discard source evidence' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER auth_erasure_index_guard BEFORE INSERT OR UPDATE ON access.erasure
 FOR EACH ROW EXECUTE FUNCTION access.auth_erasure_index_guard();

CREATE FUNCTION access.initialize_auth_erasure_partition(p integer) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE source access.auth_erasure_source; item record;
BEGIN
 source:=access.lock_auth_erasure_source(p);
 IF source.initialized THEN RETURN true; END IF;
 FOR item IN SELECT route,account_id FROM access.erasure
   WHERE route BETWEEN p*16 AND p*16+15 AND NOT auth_obligation_indexed
   ORDER BY route,account_id LIMIT 48
 LOOP
  PERFORM access.capture_auth_erasure_obligation(item.route,item.account_id,false);
 END LOOP;
 IF EXISTS(SELECT 1 FROM access.erasure WHERE route BETWEEN p*16 AND p*16+15 AND NOT auth_obligation_indexed) THEN
  RETURN false;
 END IF;
 UPDATE access.auth_erasure_source SET initialized=true WHERE partition_no=p;
 RETURN true;
END; $$;


-- Keep the retained native reversal branch intact. New Source references use the
-- same immutable association, with distinct Account, Source and recovery components.
-- PostgreSQL assigns a table-level name to the two-column equality check.
DO $$ DECLARE original_check text;
BEGIN
  SELECT conname INTO STRICT original_check FROM pg_constraint
  WHERE conrelid='access.agent_identity_recovery'::regclass AND contype='c'
    AND pg_get_expr(conbin,conrelid)='(source_transaction_id = receipt_id)';
  EXECUTE format('ALTER TABLE access.agent_identity_recovery DROP CONSTRAINT %I',original_check);
END; $$;
ALTER TABLE access.agent_identity_recovery
  DROP CONSTRAINT agent_identity_recovery_direction_check,
  ALTER COLUMN verification_intent_digest DROP NOT NULL,
  ADD COLUMN original_source jsonb,
  ADD COLUMN recovery_digest text,
  ADD CHECK (direction IN ('account-agent.verify','account-agent.unverify')),
  ADD CHECK (direction<>'account-agent.unverify' OR source_transaction_id=receipt_id),
  ADD CHECK (original_source IS NOT NULL OR
    (direction='account-agent.unverify' AND verification_intent_digest IS NOT NULL AND recovery_digest IS NULL)),
  ADD CHECK ((original_source IS NULL)=(recovery_digest IS NULL)),
  ADD CHECK (recovery_digest ~ '^[0-9a-f]{64}$');

ALTER FUNCTION access.agent_identity_recovery_valid(access.agent_identity_intent)
  RENAME TO agent_identity_retained_recovery_valid;

-- Local exact accepted claim only. Foreign job/source/participant reads belong to
-- readOriginalAccountAgentIdentity before this Account checkout is acquired.
CREATE FUNCTION access.agent_identity_original_source_valid(home integer,s jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM semantic.identity_epoch_receipt_binding b
  JOIN semantic.identity_epoch_receipt_claim c
    ON (c.partition_no,c.receipt_key,c.generation)=(b.partition_no,b.receipt_key,b.generation)
  JOIN semantic.identity_epoch_receipt_claim_commit k
    ON (k.partition_no,k.receipt_key,k.generation,k.transaction_id)=
       (c.partition_no,c.receipt_key,c.generation,c.transaction_id)
  JOIN semantic.identity_epoch_native_commit n
    ON (n.partition_no,n.transaction_id)=(c.partition_no,c.transaction_id)
    AND n.purpose='admission' AND n.xmin=k.xmin AND n.xmin=c.xmin
  JOIN core.partition p ON p.partition_no=c.partition_no AND p.write_state='active'
    AND p.epoch=n.epoch AND p.position>=n.position AND n.position>0
  WHERE b.partition_no=home AND b.receipt_key=s->'claim'->>'key'
    AND b.account_id::text=s->'input'->'receipt'->>'account' AND b.state='accepted'
    AND b.intent_digest=c.intent_digest AND (b.accepted_job,b.accepted_epoch)=(c.job_id,c.job_epoch)
    AND NOT c.imported AND c.xmin::text<>pg_current_xact_id()::text
    AND c.intent=s->'input'->'intent' AND c.receipt=s->'input'->'receipt' AND c.intent_digest=s->>'digest'
    AND s->'native'=jsonb_build_object('partition',n.partition_no,'epoch',n.epoch,
      'position',n.position::text,'transactionId',n.transaction_id::text)
    AND s->'job'=jsonb_build_object('jobId',c.job_id::text,'epoch',c.job_epoch::text)
    AND s->'claim'=jsonb_build_object('partition',c.partition_no,'key',c.receipt_key,
      'generation',c.generation::text,'transactionId',c.transaction_id::text,
      'home',c.job_home,'scope',c.scope_digest,'sources',c.sources)
 );
$$;

CREATE FUNCTION access.agent_identity_recovery_valid(i access.agent_identity_intent) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM access.agent_identity_recovery a WHERE
     (a.route,a.account_id,a.direction,a.receipt_id)=(i.route,i.account_id,i.direction,i.receipt_id)
     AND a.original_source IS NOT NULL
 ) THEN access.agent_identity_retained_recovery_valid(i) ELSE EXISTS (
  SELECT 1 FROM access.agent_identity_recovery a
  JOIN core.receipt r ON r.partition_no=a.source_partition AND r.principal_kind='account'
    AND r.principal_id=a.requested_by AND r.command_kind=i.native_command_kind
    AND r.idempotency_key=i.native_receipt_key AND r.transaction_id=a.source_transaction_id
    AND r.epoch=a.source_epoch AND r.position=a.source_position AND r.payload_state='present'
    AND r.xmin::text<>pg_current_xact_id()::text
  JOIN core.receipt c ON c.partition_no=a.source_partition AND c.principal_kind='account'
    AND c.principal_id=a.requested_by AND c.command_kind='access.agent-identity.recover'
    AND c.idempotency_key=a.recovery_receipt_key AND c.transaction_id=a.recovery_transaction_id
    AND c.epoch=a.recovery_epoch AND c.position=a.recovery_position
    AND c.xmin::text=pg_current_xact_id()::text AND c.payload_state='present'
    AND encode(c.request_digest,'hex')=a.recovery_digest
    AND c.request_digest=sha256(convert_to(format('[%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s]',
      to_json(i.delivery_key),to_json(i.source_transaction_id::text),i.source_epoch,to_json(i.source_position::text),
      to_json(i.intent_digest),COALESCE(to_json(a.verification_intent_digest)::text,'null'),
      (a.original_source->'native'->'transactionId')::text,(a.original_source->'native'->'epoch')::text,
      (a.original_source->'native'->'position')::text,(a.original_source->'claim'->'generation')::text,
      (a.original_source->'job'->'jobId')::text,(a.original_source->'job'->'epoch')::text,
      (a.original_source->'claim'->'scope')::text,COALESCE(to_json(i.decision_transaction_id::text)::text,'null'),
      COALESCE(i.decision_epoch::text,'null'),COALESCE(to_json(i.decision_position::text)::text,'null')),'UTF8'))
  JOIN core.partition p ON p.partition_no=a.source_partition AND p.write_state='active'
    AND p.epoch=a.source_epoch AND p.position>=a.recovery_position
  WHERE (a.route,a.account_id,a.direction,a.receipt_id)=(i.route,i.account_id,i.direction,i.receipt_id)
    AND a.xmin::text=pg_current_xact_id()::text
    AND a.requested_by=i.requested_by AND a.decided_by IS NOT DISTINCT FROM i.decided_by
    AND a.source_partition=i.source_partition AND a.source_epoch=i.source_epoch
    AND a.source_position=i.source_position AND a.source_transaction_id=i.source_transaction_id
    AND a.intent_digest=i.intent_digest AND NOT i.minimized
    AND i.pending_receipt_id=r.transaction_id
    AND i.delivery_key=format('["%s","%s","%s"]',i.direction,i.account_id::text,i.receipt_id::text)
    AND a.original_source->'input'=jsonb_build_object('intent',i.intent,'receipt',
      jsonb_build_object('account',i.account_id::text,'kind',i.direction,'receipt',i.receipt_id::text))
    AND a.original_source->>'digest'=i.intent_digest
    AND i.intent->>'release'=i.release
    AND access.agent_identity_original_source_valid(i.source_partition,a.original_source)
    -- The original Source admission must never masquerade as the Account command.
    AND a.original_source->'native'->>'transactionId'<>i.source_transaction_id::text
    AND a.original_source->'native'->>'transactionId'<>a.recovery_transaction_id::text
    AND (a.original_source->'native'->>'position')::bigint>i.source_position
    AND (a.original_source->'native'->>'position')::bigint<a.recovery_position
    AND ((i.direction='account-agent.verify'
      AND a.original_source->'priorVerification'='null'::jsonb
      AND a.verification_intent_digest IS NULL AND i.verification_receipt_id IS NULL
      AND i.decided_by IS NOT NULL AND i.decision_route=0 AND i.decision_receipt_id=i.receipt_id
      AND i.decision_transaction_id=i.receipt_id AND i.decision_epoch>0 AND i.decision_position>0
      AND i.intent=jsonb_build_object('kind','merge','redirected',i.agent_id::text,
        'survivor',i.catalogue_id::text,'release',i.release)
      AND i.workflow_id='accounts.agent-verification:'||i.request_id::text||':'||i.receipt_id::text
      AND r.command_kind='access.agent-verification.pending'
      AND r.response=jsonb_build_object('requestId',i.request_id::text,'accountId',i.account_id::text)
      AND r.request_digest=sha256(convert_to(format('[%s,%s,%s,%s,%s]',to_json(i.request_id::text),
        to_json(i.account_id::text),to_json(i.account_kind),to_json(i.catalogue_id::text),
        to_json(i.receipt_id::text)),'UTF8')))
    OR (i.direction='account-agent.unverify'
      AND access.agent_identity_original_source_valid(i.source_partition,a.original_source->'priorVerification')
      AND (a.original_source->'priorVerification'->'native'->>'position')::bigint<i.source_position
      AND a.original_source->'priorVerification'->>'verificationReceipt'=i.verification_receipt_id::text
      AND a.original_source->'priorVerification'->>'digest'=a.verification_intent_digest
      AND a.original_source->'priorVerification'->'input'=jsonb_build_object('intent',
        jsonb_build_object('kind','merge','redirected',i.agent_id::text,'survivor',i.catalogue_id::text,'release',i.release),
        'receipt',jsonb_build_object('account',i.account_id::text,'kind','account-agent.verify',
          'receipt',i.verification_receipt_id::text))
      AND a.original_source->'priorVerification'->'job'=i.intent->'undoJob'
      AND i.intent=jsonb_build_object('kind','unmerge','original',i.agent_id::text,'release',i.release,
        'verificationReceipt',i.verification_receipt_id::text,'undoJob',
        jsonb_build_object('jobId',i.undo_job_id::text,'epoch',i.undo_job_epoch::text))
      AND i.request_id IS NULL AND i.decision_route IS NULL AND i.decision_receipt_id IS NULL
      AND i.decision_epoch IS NULL AND i.decision_position IS NULL AND i.decision_transaction_id IS NULL
      AND i.workflow_id='accounts.agent-verification-reversal:'||i.account_id::text||':'||i.receipt_id::text
      AND r.response=jsonb_build_object('accountId',i.account_id::text,'receiptId',i.receipt_id::text,
        'requestedBy',i.requested_by::text,'kind',i.disposition,'reason',i.reason,
        'catalogueSubjectId',i.catalogue_id::text,'verificationReceiptId',i.verification_receipt_id::text)
      AND i.decided_by IS NOT DISTINCT FROM CASE WHEN i.disposition='revoked' THEN i.requested_by END
      AND ((r.command_kind='access.agent-verification.deleted' AND i.disposition='revoked'
        AND i.reason='Account deleted' AND i.requested_by=i.account_id
        AND r.request_digest=sha256(convert_to(i.account_id::text,'UTF8'))
        AND EXISTS (SELECT 1 FROM access.account t WHERE t.route=i.route AND t.account_id=i.account_id AND t.state='deleted'))
      OR (r.command_kind='access.agent-verification.'||i.disposition AND EXISTS (
        SELECT 1 FROM editorial.write_basis b WHERE b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
          AND b.principal_kind='account' AND b.principal_id=r.principal_id AND b.epoch=r.epoch AND b.position=r.position)))))
 ) END;
$$;


-- Access owns accepted technical undo custody. This is personal technical data and
-- deliberately remains pending in the native inventory, never a nonpersonal disposition.
CREATE TABLE access.agent_identity_technical_source (
 route integer NOT NULL CHECK(route BETWEEN 0 AND 65535),
 account_id uuid NOT NULL,
 direction text NOT NULL CHECK(direction IN ('account-agent.verify','account-agent.unverify')),
 receipt_id uuid NOT NULL,
 intent jsonb NOT NULL CHECK(octet_length(intent::text)<=2048),
 source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
 source_partition integer NOT NULL,
 source_epoch integer NOT NULL CHECK(source_epoch>0),
 source_position bigint NOT NULL CHECK(source_position>0),
 source_transaction_id uuid NOT NULL,
 accepted_job_id uuid NOT NULL,
 accepted_job_epoch bigint NOT NULL CHECK(accepted_job_epoch>0),
 binding_generation bigint NOT NULL CHECK(binding_generation>0),
 binding_transaction_id uuid NOT NULL,
 workflow_id text NOT NULL CHECK(octet_length(workflow_id)<=256),
 receiving_transaction_id uuid NOT NULL,
 receiving_epoch integer NOT NULL CHECK(receiving_epoch>0),
 domain_generation bigint NOT NULL CHECK(domain_generation>0),
 receiving_position bigint NOT NULL CHECK(receiving_position>0),
 PRIMARY KEY(route,account_id,direction,receipt_id),
 CHECK(route=get_byte(uuid_send(account_id),10)*256+get_byte(uuid_send(account_id),11)),
 CHECK(source_partition=route/16),
 CHECK(receiving_transaction_id<>source_transaction_id),
 CHECK((direction='account-agent.verify' AND intent->>'kind'='merge'
   AND intent ?& ARRAY['kind','redirected','survivor','release']
   AND intent-ARRAY['kind','redirected','survivor','release']='{}'::jsonb)
  OR (direction='account-agent.unverify' AND intent->>'kind'='unmerge'
   AND intent ?& ARRAY['kind','original','undoJob','verificationReceipt','release']
   AND intent-ARRAY['kind','original','undoJob','verificationReceipt','release']='{}'::jsonb
   AND intent->'undoJob' ?& ARRAY['jobId','epoch']
   AND (intent->'undoJob')-ARRAY['jobId','epoch']='{}'::jsonb))
);
CREATE INDEX erasure_agent_identity_technical_source_account ON access.agent_identity_technical_source
 (account_id,route,direction,receipt_id);

-- Native inventory of the Account subject actually retained in the technical payload.
-- Original requester/decider and inherited History attribution are not technical input.
CREATE TABLE access.agent_identity_technical_role (
 route integer NOT NULL,
 account_id uuid NOT NULL,
 direction text NOT NULL,
 receipt_id uuid NOT NULL,
 role_account_id uuid NOT NULL,
 roles integer NOT NULL CHECK(roles BETWEEN 1 AND 262143),
 CONSTRAINT identity_technical_retained_subject CHECK(role_account_id=account_id AND roles=32),
 PRIMARY KEY(route,account_id,direction,receipt_id,role_account_id),
 FOREIGN KEY(route,account_id,direction,receipt_id)
  REFERENCES access.agent_identity_technical_source(route,account_id,direction,receipt_id)
);
CREATE INDEX erasure_agent_identity_technical_role_account ON access.agent_identity_technical_role
 (role_account_id,route,account_id,direction,receipt_id);
CREATE INDEX erasure_agent_identity_technical_role_owner ON access.agent_identity_technical_role
 (account_id,route,direction,receipt_id,role_account_id);

CREATE FUNCTION access.validate_identity_technical_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 -- The finalizer appends the actual eventful fence in this PostgreSQL transaction.
 -- A predicted position alone (or a replayed/caller-supplied transaction stamp) cannot commit.
 IF NEW.receiving_transaction_id::text IS DISTINCT FROM current_setting('access.identity_technical_transaction',true)
  OR NOT EXISTS(SELECT 1 FROM core.outbox o JOIN core.partition p USING(partition_no)
    WHERE o.partition_no=NEW.source_partition AND o.epoch=NEW.receiving_epoch
      AND o.position=NEW.receiving_position AND o.event_seq=0
      AND o.xmin::text=pg_current_xact_id()::text
      AND p.epoch=o.epoch AND p.position=o.position AND p.write_state='active')
  OR NOT EXISTS(SELECT 1 FROM access.agent_identity_technical_role r
    WHERE (r.route,r.account_id,r.direction,r.receipt_id)=
      (NEW.route,NEW.account_id,NEW.direction,NEW.receipt_id)
      AND r.role_account_id=NEW.account_id AND r.roles=32) THEN
  RAISE EXCEPTION 'Accounts technical custody lacks same-command native receiving fence/inventory' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER identity_technical_source_native_commit
 AFTER INSERT ON access.agent_identity_technical_source DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION access.validate_identity_technical_source();
CREATE FUNCTION access.guard_identity_technical_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Accepted Accounts technical custody requires its native consumer release';
END; $$;
CREATE TRIGGER identity_technical_source_immutable BEFORE UPDATE OR DELETE
 ON access.agent_identity_technical_source FOR EACH ROW EXECUTE FUNCTION access.guard_identity_technical_source();
CREATE TRIGGER identity_technical_role_immutable BEFORE UPDATE OR DELETE
 ON access.agent_identity_technical_role FOR EACH ROW EXECUTE FUNCTION access.guard_identity_technical_source();
CREATE TRIGGER identity_technical_source_no_truncate BEFORE TRUNCATE
 ON access.agent_identity_technical_source FOR EACH STATEMENT EXECUTE FUNCTION access.guard_identity_technical_source();
CREATE TRIGGER identity_technical_role_no_truncate BEFORE TRUNCATE
 ON access.agent_identity_technical_role FOR EACH STATEMENT EXECUTE FUNCTION access.guard_identity_technical_source();
