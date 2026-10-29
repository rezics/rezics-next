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
-- Name: guard_account_creation_time(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_account_creation_time() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Account creation time is immutable' USING ERRCODE = '23514';
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
  RAISE EXCEPTION 'Membership terminal proof is immutable' USING ERRCODE = '23514';
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
-- Name: operator_fence_page_immutable(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.operator_fence_page_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Operator fence pages are immutable';
END;
$$;


--
-- Name: record_public_account_change(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.record_public_account_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
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


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account (
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
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
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
    public_changed_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
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
    requested_by uuid NOT NULL,
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
    CONSTRAINT agent_verification_request_check2 CHECK (((state = ANY (ARRAY['approving'::text, 'approved'::text, 'rejected'::text, 'failed'::text])) = (decided_by IS NOT NULL))),
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
    CONSTRAINT erasure_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT erasure_check1 CHECK (((completed_at IS NULL) OR (completed_at >= at))),
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
    account_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
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
    route integer NOT NULL,
    normalized_handle text NOT NULL COLLATE pg_catalog."C",
    account_id uuid NOT NULL,
    state text NOT NULL,
    expires_at timestamp with time zone,
    reserved_until timestamp with time zone,
    transaction_id uuid NOT NULL,
    reservation_id uuid,
    hold_operation_id text,
    hold_expected_handle text,
    former_until timestamp with time zone,
    CONSTRAINT handle_claim_check CHECK ((route = ((get_byte(sha256(convert_to(normalized_handle, 'UTF8'::name)), 0) * 256) + get_byte(sha256(convert_to(normalized_handle, 'UTF8'::name)), 1)))),
    CONSTRAINT handle_claim_check1 CHECK ((((state = 'pending'::text) AND (expires_at IS NOT NULL) AND (reserved_until IS NULL)) OR ((state = 'active'::text) AND (expires_at IS NULL) AND (reserved_until IS NULL)) OR ((state = 'reserved'::text) AND (expires_at IS NULL) AND (reserved_until IS NOT NULL)))),
    CONSTRAINT handle_claim_former_until_check CHECK (((former_until IS NULL) OR (state = ANY (ARRAY['pending'::text, 'reserved'::text])))),
    CONSTRAINT handle_claim_normalized_handle_check CHECK ((normalized_handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT handle_claim_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT handle_claim_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'reserved'::text])))
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
    cursor_member uuid,
    cursor_valid tstzrange,
    complete boolean DEFAULT false NOT NULL,
    handle_key text NOT NULL,
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
    CONSTRAINT resource_denial_action_check CHECK ((action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'::text)),
    CONSTRAINT resource_denial_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_denial_reason_check CHECK ((reason = ANY (ARRAY['resource'::text, 'suspension'::text, 'realm_ban'::text]))),
    CONSTRAINT resource_denial_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_denial_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_denial_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
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
    CONSTRAINT resource_grant_action_check CHECK ((action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'::text)),
    CONSTRAINT resource_grant_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_grant_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_grant_subject_check CHECK ((((subject_kind = 'identity'::text) AND (subject_id <> '00000000-0000-0000-0000-000000000000'::uuid)) OR ((subject_kind = 'active_accounts'::text) AND (subject_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (subject_role = ''::text)))),
    CONSTRAINT resource_grant_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['identity'::text, 'active_accounts'::text]))),
    CONSTRAINT resource_grant_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_grant_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: resource_initialization; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_initialization (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    resource_type text NOT NULL,
    creator_id uuid NOT NULL,
    initialized_at timestamp with time zone NOT NULL,
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
    CONSTRAINT resource_role_grant_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_role_grant_check1 CHECK ((((subject_kind = 'identity'::text) AND (subject_id <> '00000000-0000-0000-0000-000000000000'::uuid)) OR ((subject_kind = 'active_accounts'::text) AND (subject_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (subject_role = ''::text)))),
    CONSTRAINT resource_role_grant_grant_role_check CHECK ((grant_role ~ '^[a-z][a-z0-9_.-]*$'::text)),
    CONSTRAINT resource_role_grant_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_role_grant_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['identity'::text, 'active_accounts'::text]))),
    CONSTRAINT resource_role_grant_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_role_grant_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: standing_parent_installation; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.standing_parent_installation (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    actions text[] NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT standing_parent_installation_actions_check CHECK ((cardinality(actions) > 0)),
    CONSTRAINT standing_parent_installation_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT standing_parent_installation_route_check CHECK (((route >= 0) AND (route <= 65535)))
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
    CONSTRAINT credential_expiry CHECK ((((operation ->> 'kind'::text) <> 'credential'::text) OR (expires_at <= (created_at + '00:01:00'::interval)))),
    CONSTRAINT workflow_approval_authn_epoch_check CHECK (((authn_epoch > 0) AND (authn_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT workflow_approval_check CHECK ((route = ((get_byte(uuid_send(approval_id), 10) * 256) + get_byte(uuid_send(approval_id), 11)))),
    CONSTRAINT workflow_approval_check1 CHECK ((route = ((get_byte(uuid_send(actor_id), 10) * 256) + get_byte(uuid_send(actor_id), 11)))),
    CONSTRAINT workflow_approval_check2 CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '00:05:00'::interval)) AND (expires_at <= jwt_expires_at))),
    CONSTRAINT workflow_approval_client_id_check CHECK (((length(client_id) >= 1) AND (length(client_id) <= 1024))),
    CONSTRAINT workflow_approval_digest_check CHECK ((digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT workflow_approval_operation_check CHECK (((jsonb_typeof(operation) = 'object'::text) AND (octet_length((operation)::text) <= 16384))),
    CONSTRAINT workflow_approval_operation_key_check CHECK (((length(operation_key) >= 1) AND (length(operation_key) <= 255))),
    CONSTRAINT workflow_approval_requested_by_check CHECK ((length(requested_by) <= 100)),
    CONSTRAINT workflow_approval_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT workflow_approval_scopes_check CHECK (((cardinality(scopes) <= 6450) AND (octet_length(array_to_string(scopes, ' '::text)) <= 12900)))
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
-- Name: erasure erasure_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.erasure
    ADD CONSTRAINT erasure_pkey PRIMARY KEY (route, account_id);


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
-- Name: resource_denial resource_denial_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_denial
    ADD CONSTRAINT resource_denial_pkey PRIMARY KEY (route, resource_id, subject_id, subject_role, action, reason, valid WITHOUT OVERLAPS);


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
-- Name: resource_role_grant resource_role_grant_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_role_grant
    ADD CONSTRAINT resource_role_grant_pkey PRIMARY KEY (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid WITHOUT OVERLAPS);


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
-- Name: committed_continuation_barrier; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX committed_continuation_barrier ON access.committed_continuation USING btree (route, account_id, barrier_receipt_id);


--
-- Name: committed_continuation_operator_latest; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX committed_continuation_operator_latest ON access.committed_continuation USING btree (route, account_id, minimum_authn_epoch DESC) WHERE (allowlist @> '[{"step": "operator-responsibility-page"}]'::jsonb);


--
-- Name: lifecycle_coordination_purpose_page; Type: INDEX; Schema: access; Owner: -
--

CREATE INDEX lifecycle_coordination_purpose_page ON access.lifecycle_coordination USING btree (route, account_id, purpose, reservation_id);


--
-- Name: lifecycle_membership_live; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX lifecycle_membership_live ON access.lifecycle_membership_slot USING btree (route, organization_id, member_account_id) WHERE (NOT terminal);


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

CREATE INDEX resource_grant_pkey_lookup ON access.resource_grant USING btree (route, resource_id, subject_kind, subject_id, subject_role, action, valid) WHERE ((route = 0) AND (resource_id = '00000000-0000-8000-8000-000000000000'::uuid));


--
-- Name: resource_role_grant_open; Type: INDEX; Schema: access; Owner: -
--

CREATE UNIQUE INDEX resource_role_grant_open ON access.resource_role_grant USING btree (route, resource_id, subject_kind, subject_id, subject_role, grant_role) WHERE upper_inf(valid);


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
-- Name: erasure_acknowledgement erasure_acknowledgement_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER erasure_acknowledgement_guard BEFORE DELETE OR UPDATE ON access.erasure_acknowledgement FOR EACH ROW EXECUTE FUNCTION access.guard_erasure_acknowledgement();


--
-- Name: erasure erasure_guard; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER erasure_guard BEFORE DELETE OR UPDATE ON access.erasure FOR EACH ROW EXECUTE FUNCTION access.guard_erasure();


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
-- Name: workflow_approval workflow_approval_immutable; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER workflow_approval_immutable BEFORE UPDATE ON access.workflow_approval FOR EACH ROW EXECUTE FUNCTION access.workflow_approval_immutable();


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


