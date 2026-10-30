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
-- Name: community; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA community;


--
-- Name: guard_publication(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.actor IS NOT NULL AND NEW.actor IS NULL
     AND (to_jsonb(NEW) - 'actor') = (to_jsonb(OLD) - 'actor') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Publication records are append-only' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_publication_head(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_publication_head() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.realm_id, NEW.subject_id)
     IS DISTINCT FROM ROW(OLD.route, OLD.realm_id, OLD.subject_id) THEN
    RAISE EXCEPTION 'Publication slot identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_realm(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.realm_id, NEW.space_id, NEW.created_at, NEW.creator)
     IS DISTINCT FROM ROW(OLD.route, OLD.realm_id, OLD.space_id, OLD.created_at, OLD.creator) THEN
    RAISE EXCEPTION 'Realm identity and creation provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_realm_member_terminal(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_member_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Realm membership terminal slots are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_realm_membership_operation(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_membership_operation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  attribution text[] := ARRAY['member_account_id', 'initiator_account_id', 'original_operator_account_id',
    'actor_client_id', 'actor_scopes', 'actor_requested_by', 'actor_authn_epoch',
    'original_minimum_authn_epoch', 'original_delegation_transaction_id', 'original_delegation_issued_valid'];
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - attribution) = (to_jsonb(OLD) - attribution)
     AND (NEW.member_account_id IS NULL OR NEW.member_account_id = OLD.member_account_id)
     AND (NEW.initiator_account_id IS NULL OR NEW.initiator_account_id = OLD.initiator_account_id)
     AND (NEW.original_operator_account_id IS NULL OR NEW.original_operator_account_id = OLD.original_operator_account_id)
     AND NEW.actor_client_id IS NULL AND NEW.actor_scopes IS NULL AND NEW.actor_requested_by IS NULL
     AND NEW.actor_authn_epoch IS NULL AND NEW.original_minimum_authn_epoch IS NULL
     AND NEW.original_delegation_transaction_id IS NULL AND NEW.original_delegation_issued_valid IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Realm membership operations are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_realm_revision(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('community.erasure_account', true) = OLD.author::text
       AND NEW.title = '' AND NEW.summary = ''
       AND (to_jsonb(NEW) - 'title' - 'summary') = (to_jsonb(OLD) - 'title' - 'summary')
       AND EXISTS (SELECT 1 FROM community.realm
                   WHERE route = OLD.route AND realm_id = OLD.realm_id
                     AND head_revision_id <> OLD.revision_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Realm revisions are append-only' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_space(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_space() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.space_id, NEW.created_at, NEW.creator)
     IS DISTINCT FROM ROW(OLD.route, OLD.space_id, OLD.created_at, OLD.creator) THEN
    RAISE EXCEPTION 'Space identity and creation provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_space_revision(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_space_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF current_setting('community.erasure_account', true) = OLD.author::text
       AND NEW.title = '' AND NEW.summary = ''
       AND (to_jsonb(NEW) - 'title' - 'summary') = (to_jsonb(OLD) - 'title' - 'summary')
       AND EXISTS (SELECT 1 FROM community.space
                   WHERE route = OLD.route AND space_id = OLD.space_id
                     AND head_revision_id <> OLD.revision_id) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Space revisions are append-only' USING ERRCODE = '23514';
END;
$$;


--
-- Name: inherit_realm_board_scheme(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.inherit_realm_board_scheme() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT board_scheme_id INTO NEW.board_scheme_id
  FROM community.realm_revision
  WHERE route = NEW.route AND realm_id = NEW.realm_id AND revision_id = NEW.predecessor;
  RETURN NEW;
END;
$$;


--
-- Name: inherit_realm_votes(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.inherit_realm_votes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT votes INTO NEW.votes
  FROM community.realm_revision
  WHERE route = NEW.route AND realm_id = NEW.realm_id AND revision_id = NEW.predecessor;
  RETURN NEW;
END;
$$;


--
-- Name: realm_revision_votes(integer, uuid, uuid); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.realm_revision_votes(route integer, realm_id uuid, revision_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  found jsonb;
BEGIN
  SELECT revision.votes INTO found
  FROM community.realm_revision AS revision
  WHERE revision.route = realm_revision_votes.route
    AND revision.realm_id = realm_revision_votes.realm_id
    AND revision.revision_id = realm_revision_votes.revision_id;
  RETURN found;
END;
$$;


--
-- Name: realm_votes_allowed(jsonb); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.realm_votes_allowed(votes jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN votes IS NULL OR jsonb_typeof(votes) <> 'object' THEN false
    WHEN (SELECT count(*) FROM jsonb_object_keys(votes)) > 7 THEN false
    WHEN EXISTS (
      SELECT 1
      FROM jsonb_each(votes) AS entry(key, value)
      WHERE entry.key <> ALL (ARRAY['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'])
         OR jsonb_typeof(entry.value) <> 'number'
         OR (entry.value <> '1'::jsonb AND entry.value <> '-1'::jsonb)
    ) THEN false
    ELSE true
  END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_erasure_progress; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.account_erasure_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    step bigint DEFAULT 0 NOT NULL,
    phase text NOT NULL,
    cursor jsonb,
    erased_at timestamp with time zone NOT NULL,
    community_found boolean DEFAULT false NOT NULL,
    phase_pending boolean DEFAULT false NOT NULL,
    reasons_kept_until timestamp with time zone,
    rating_had_votes boolean DEFAULT false NOT NULL,
    CONSTRAINT account_erasure_progress_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_erasure_progress_check1 CHECK (isfinite(erased_at)),
    CONSTRAINT account_erasure_progress_check2 CHECK (((reasons_kept_until IS NULL) OR isfinite(reasons_kept_until))),
    CONSTRAINT account_erasure_progress_phase_check CHECK ((phase = ANY (ARRAY['close'::text, 'memberships'::text, 'revisions'::text, 'records'::text, 'notices'::text, 'rating'::text, 'proof'::text, 'complete'::text]))),
    CONSTRAINT account_erasure_progress_step_check CHECK ((step >= 0))
);


--
-- Name: erasure_fence; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.erasure_fence (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT erasure_fence_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT erasure_fence_closed_at_check CHECK (((closed_at IS NULL) OR isfinite(closed_at)))
);


--
-- Name: party_locator; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.party_locator (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    owner_route integer NOT NULL,
    owner_id uuid NOT NULL,
    key text NOT NULL,
    CONSTRAINT party_locator_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT party_locator_check1 CHECK ((owner_route = ((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11)))),
    CONSTRAINT party_locator_due_at_check CHECK (isfinite(due_at)),
    CONSTRAINT party_locator_key_check CHECK (((char_length(key) >= 1) AND (char_length(key) <= 100))),
    CONSTRAINT party_locator_kind_check CHECK ((kind = ANY (ARRAY['ban_target'::text, 'ban_actor'::text, 'membership_operation'::text, 'verdict'::text, 'claim_request'::text, 'space_remover'::text, 'realm_remover'::text]))),
    CONSTRAINT party_locator_owner_route_check CHECK (((owner_route >= 0) AND (owner_route <= 65535))),
    CONSTRAINT party_locator_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: publication; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.publication (
    route integer NOT NULL,
    publication_id uuid NOT NULL,
    realm_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    verdict text NOT NULL,
    predecessor uuid,
    subject_revision_id uuid,
    actor uuid,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT publication_check CHECK ((predecessor <> publication_id)),
    CONSTRAINT publication_check1 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT publication_check2 CHECK ((route = ((get_byte(uuid_send(publication_id), 10) * 256) + get_byte(uuid_send(publication_id), 11)))),
    CONSTRAINT publication_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT publication_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT publication_verdict_check CHECK ((verdict = ANY (ARRAY['adopt'::text, 'reject'::text, 'withdraw'::text])))
);


--
-- Name: publication_head; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.publication_head (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    verdict text NOT NULL,
    published_at timestamp with time zone NOT NULL,
    CONSTRAINT publication_head_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT publication_head_check1 CHECK ((route = ((get_byte(uuid_send(publication_id), 10) * 256) + get_byte(uuid_send(publication_id), 11)))),
    CONSTRAINT publication_head_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT publication_head_verdict_check CHECK ((verdict = ANY (ARRAY['adopt'::text, 'reject'::text, 'withdraw'::text])))
);


--
-- Name: realm; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    space_id uuid NOT NULL,
    state text NOT NULL,
    visibility text NOT NULL,
    context_id uuid NOT NULL,
    head_revision_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    creator uuid NOT NULL,
    board_scheme_id uuid,
    votes jsonb DEFAULT '{"upvote": 1, "downvote": -1}'::jsonb NOT NULL,
    ownership_state text DEFAULT 'owned'::text NOT NULL,
    orphaned_at timestamp with time zone,
    claim_eligible_at timestamp with time zone,
    CONSTRAINT realm_ownership_check CHECK (
      (ownership_state = 'owned' AND orphaned_at IS NULL AND claim_eligible_at IS NULL)
      OR (ownership_state = 'orphaned' AND orphaned_at IS NOT NULL AND claim_eligible_at IS NOT NULL
          AND isfinite(orphaned_at) AND claim_eligible_at = orphaned_at + interval '720 hours')
    ),
    lifecycle_version bigint DEFAULT 0 NOT NULL,
    removed_at timestamp with time zone,
    removed_by uuid,
    remover_role text,
    removal_reason text,
    CONSTRAINT realm_board_scheme_id_check CHECK (((board_scheme_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT realm_check CHECK ((realm_id <> space_id)),
    CONSTRAINT realm_check1 CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT realm_check2 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_check3 CHECK ((route = ((get_byte(uuid_send(head_revision_id), 10) * 256) + get_byte(uuid_send(head_revision_id), 11)))),
    CONSTRAINT realm_lifecycle_version_check CHECK ((lifecycle_version >= 0)),
    CONSTRAINT realm_removal_check CHECK ((((removed_at IS NULL) AND (removed_by IS NULL) AND (remover_role IS NULL) AND (removal_reason IS NULL) AND (state = 'active'::text)) OR ((removed_at IS NOT NULL) AND (remover_role IS NOT NULL)))),
    CONSTRAINT realm_removal_reason_check CHECK (((char_length(removal_reason) >= 1) AND (char_length(removal_reason) <= 1024))),
    CONSTRAINT realm_remover_role_check CHECK ((remover_role = ANY (ARRAY['owner'::text, 'moderator'::text]))),
    CONSTRAINT realm_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_state_check CHECK ((state = ANY (ARRAY['active'::text, 'removed'::text]))),
    CONSTRAINT realm_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'protected'::text]))),
    CONSTRAINT realm_votes_check CHECK (community.realm_votes_allowed(votes))
);


--
-- Name: realm_ban; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_ban (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    valid tstzrange NOT NULL,
    reason text NOT NULL,
    actor uuid,
    transaction_id uuid NOT NULL,
    CONSTRAINT realm_ban_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_ban_reason_check CHECK ((char_length(reason) <= 1024)),
    CONSTRAINT realm_ban_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_ban_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: realm_member; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_member (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    role text NOT NULL,
    valid tstzrange NOT NULL,
    reservation_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT realm_member_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_member_role_check CHECK ((role = 'member'::text)),
    CONSTRAINT realm_member_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_member_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: realm_member_terminal; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_member_terminal (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    at timestamp with time zone NOT NULL,
    CONSTRAINT realm_member_terminal_at_check CHECK (isfinite(at)),
    CONSTRAINT realm_member_terminal_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_member_terminal_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: realm_membership_operation; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_membership_operation (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL,
    realm_id uuid NOT NULL,
    space_id uuid NOT NULL,
    member_account_id uuid,
    reservation_id uuid,
    ban_id uuid,
    initiator_account_id uuid,
    actor_client_id text,
    actor_scopes text[],
    actor_requested_by text,
    actor_authn_epoch bigint,
    requested_at timestamp with time zone NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    source_digest text NOT NULL,
    original_minimum_authn_epoch text,
    original_operator_account_id uuid,
    original_delegation_transaction_id uuid,
    original_delegation_issued_valid text,
    creation_command_kind text NOT NULL,
    creation_idempotency_key text NOT NULL,
    creation_request_digest text NOT NULL,
    creation_target_route integer NOT NULL,
    creation_target_id uuid NOT NULL,
    CONSTRAINT realm_membership_operation_actor_authn_epoch_check CHECK (((actor_authn_epoch >= 1) AND (actor_authn_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT realm_membership_operation_actor_client_id_check CHECK (((char_length(actor_client_id) >= 1) AND (char_length(actor_client_id) <= 1024))),
    CONSTRAINT realm_membership_operation_actor_requested_by_check CHECK ((actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)),
    CONSTRAINT realm_membership_operation_actor_scopes_check CHECK (((cardinality(actor_scopes) <= 512) AND ((cardinality(actor_scopes) = 0) OR (array_ndims(actor_scopes) = 1)))),
    CONSTRAINT realm_membership_operation_check CHECK ((route = ((get_byte(uuid_send(operation_id), 10) * 256) + get_byte(uuid_send(operation_id), 11)))),
    CONSTRAINT realm_membership_operation_check1 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_membership_operation_check2 CHECK ((((kind = 'join'::text) AND (reservation_id IS NULL) AND (ban_id IS NULL)) OR ((kind = 'leave'::text) AND (reservation_id IS NOT NULL) AND (ban_id IS NULL) AND (member_account_id = initiator_account_id)) OR ((kind = 'removal'::text) AND (reservation_id IS NOT NULL) AND (ban_id IS NOT NULL)))),
    CONSTRAINT realm_membership_operation_check3 CHECK (((actor_requested_by IS NULL) = (original_delegation_transaction_id IS NULL))),
    CONSTRAINT realm_membership_operation_check4 CHECK (((original_delegation_transaction_id IS NULL) = (original_delegation_issued_valid IS NULL))),
    CONSTRAINT realm_membership_operation_creation_command_kind_check CHECK ((creation_command_kind ~ '^[!-~]{1,255}$'::text)),
    CONSTRAINT realm_membership_operation_creation_idempotency_key_check CHECK ((creation_idempotency_key ~ '^[!-~]{1,255}$'::text)),
    CONSTRAINT realm_membership_operation_creation_request_digest_check CHECK ((creation_request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT realm_membership_operation_creation_target_route_check CHECK (((creation_target_route >= 0) AND (creation_target_route <= 65535))),
    CONSTRAINT realm_membership_operation_kind_check CHECK ((kind = ANY (ARRAY['join'::text, 'leave'::text, 'removal'::text]))),
    CONSTRAINT realm_membership_operation_original_delegation_issued_val_check CHECK ((char_length(original_delegation_issued_valid) <= 256)),
    CONSTRAINT realm_membership_operation_original_minimum_authn_epoch_check CHECK ((original_minimum_authn_epoch ~ '^[1-9][0-9]{0,18}$'::text)),
    CONSTRAINT realm_membership_operation_requested_at_check CHECK (isfinite(requested_at)),
    CONSTRAINT realm_membership_operation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_membership_operation_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: realm_membership_proof; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_membership_proof (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    generation_id uuid NOT NULL,
    operation_id text NOT NULL,
    outcome text NOT NULL,
    transaction_id uuid NOT NULL,
    publication_transaction_id uuid,
    principal_id uuid NOT NULL,
    command_kind text NOT NULL,
    command_key text NOT NULL,
    at timestamp with time zone NOT NULL,
    CONSTRAINT realm_membership_proof_at_check CHECK (isfinite(at)),
    CONSTRAINT realm_membership_proof_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_membership_proof_outcome_check CHECK ((outcome = ANY (ARRAY['published'::text, 'cancelled'::text])))
);


--
-- Name: realm_revision; Type: TABLE; Schema: community; Owner: -
--

CREATE FUNCTION community.realm_presentation_allowed(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE key text; ref jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR
     NOT value ?& ARRAY['avatarMediaId','bannerMediaId','rules'] OR
     (SELECT count(*) FROM jsonb_object_keys(value)) <> 3 THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['avatarMediaId','bannerMediaId'] LOOP
    ref := value -> key;
    IF ref <> 'null'::jsonb AND (jsonb_typeof(ref) <> 'string' OR
      (ref #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN false; END IF;
  END LOOP;
  ref := value -> 'rules';
  IF ref = 'null'::jsonb THEN RETURN true; END IF;
  IF jsonb_typeof(ref) <> 'object' OR NOT ref ?& ARRAY['postId','revisionId'] OR
     (SELECT count(*) FROM jsonb_object_keys(ref)) <> 2 THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['postId','revisionId'] LOOP
    IF jsonb_typeof(ref -> key) <> 'string' OR (ref ->> key) !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE TABLE community.realm_revision (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    predecessor uuid,
    title text NOT NULL,
    summary text NOT NULL,
    visibility text NOT NULL,
    context_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    author uuid NOT NULL,
    board_scheme_id uuid,
    votes jsonb DEFAULT '{"upvote": 1, "downvote": -1}'::jsonb NOT NULL,
    presentation jsonb DEFAULT '{"avatarMediaId":null,"bannerMediaId":null,"rules":null}'::jsonb NOT NULL,
    CONSTRAINT realm_revision_presentation_check CHECK (community.realm_presentation_allowed(presentation)),
    CONSTRAINT realm_revision_board_scheme_id_check CHECK (((board_scheme_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT realm_revision_check CHECK ((predecessor <> revision_id)),
    CONSTRAINT realm_revision_check1 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_revision_check2 CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT realm_revision_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT realm_revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_revision_summary_check CHECK ((char_length(summary) <= 4096)),
    CONSTRAINT realm_revision_title_check CHECK (((char_length(title) >= 0) AND (char_length(title) <= 1024))),
    CONSTRAINT realm_revision_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'protected'::text]))),
    CONSTRAINT realm_revision_votes_check CHECK (community.realm_votes_allowed(votes))
)
WITH (fillfactor='50');


--
-- Name: revision_locator; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.revision_locator (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL COLLATE pg_catalog."C",
    owner_route integer NOT NULL,
    owner_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    CONSTRAINT revision_locator_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT revision_locator_check1 CHECK ((owner_route = ((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11)))),
    CONSTRAINT revision_locator_check2 CHECK ((owner_route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT revision_locator_kind_check CHECK ((kind = ANY (ARRAY['realm'::text, 'space'::text]))),
    CONSTRAINT revision_locator_owner_route_check CHECK (((owner_route >= 0) AND (owner_route <= 65535))),
    CONSTRAINT revision_locator_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: space; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space (
    route integer NOT NULL,
    space_id uuid NOT NULL,
    state text NOT NULL,
    head_revision_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    creator uuid NOT NULL,
    lifecycle_version bigint DEFAULT 0 NOT NULL,
    removed_at timestamp with time zone,
    removed_by uuid,
    remover_role text,
    removal_reason text,
    CONSTRAINT space_check CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT space_check1 CHECK ((route = ((get_byte(uuid_send(head_revision_id), 10) * 256) + get_byte(uuid_send(head_revision_id), 11)))),
    CONSTRAINT space_lifecycle_version_check CHECK ((lifecycle_version >= 0)),
    CONSTRAINT space_removal_check CHECK ((((removed_at IS NULL) AND (removed_by IS NULL) AND (remover_role IS NULL) AND (removal_reason IS NULL) AND (state = 'active'::text)) OR ((removed_at IS NOT NULL) AND (remover_role IS NOT NULL)))),
    CONSTRAINT space_removal_reason_check CHECK (((char_length(removal_reason) >= 1) AND (char_length(removal_reason) <= 1024))),
    CONSTRAINT space_remover_role_check CHECK ((remover_role = ANY (ARRAY['owner'::text, 'moderator'::text]))),
    CONSTRAINT space_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_state_check CHECK ((state = ANY (ARRAY['active'::text, 'removed'::text])))
);


--
-- Name: space_address_claim; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_address_claim (
    route integer NOT NULL,
    normalized_address text NOT NULL COLLATE pg_catalog."C",
    space_id uuid NOT NULL,
    state text NOT NULL,
    expires_at timestamp with time zone,
    reserved_until timestamp with time zone,
    reservation_id uuid,
    transaction_id uuid NOT NULL,
    CONSTRAINT space_address_claim_check CHECK ((route = ((get_byte(sha256(convert_to(normalized_address, 'UTF8'::name)), 0) * 256) + get_byte(sha256(convert_to(normalized_address, 'UTF8'::name)), 1)))),
    CONSTRAINT space_address_claim_check1 CHECK ((((state = 'pending'::text) AND (expires_at IS NOT NULL) AND (reserved_until IS NULL)) OR ((state = 'active'::text) AND (expires_at IS NULL) AND (reserved_until IS NULL)) OR ((state = 'reserved'::text) AND (expires_at IS NULL) AND (reserved_until IS NOT NULL)))),
    CONSTRAINT space_address_claim_normalized_address_check CHECK ((normalized_address ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT space_address_claim_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_address_claim_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'reserved'::text])))
);


--
-- Name: space_revision; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_revision (
    route integer NOT NULL,
    space_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    predecessor uuid,
    title text NOT NULL,
    summary text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    author uuid NOT NULL,
    address text,
    CONSTRAINT space_revision_check CHECK ((predecessor <> revision_id)),
    CONSTRAINT space_revision_check1 CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT space_revision_check2 CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT space_revision_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT space_revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_revision_summary_check CHECK ((char_length(summary) <= 4096)),
    CONSTRAINT space_revision_title_check CHECK (((char_length(title) >= 0) AND (char_length(title) <= 1024)))
)
WITH (fillfactor='50');


--
-- Name: account_erasure_progress account_erasure_progress_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--
ALTER TABLE ONLY community.account_erasure_progress
    ADD CONSTRAINT account_erasure_progress_pkey PRIMARY KEY (route, account_id);


--
-- Name: erasure_fence erasure_fence_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--
ALTER TABLE ONLY community.erasure_fence
    ADD CONSTRAINT erasure_fence_pkey PRIMARY KEY (route, account_id);


--
-- Name: party_locator party_locator_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.party_locator
    ADD CONSTRAINT party_locator_pkey PRIMARY KEY (route, account_id, kind, due_at, owner_route, owner_id, key);


--
-- Name: publication_head publication_head_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication_head
    ADD CONSTRAINT publication_head_pkey PRIMARY KEY (route, realm_id, subject_id);


--
-- Name: publication publication_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_pkey PRIMARY KEY (route, publication_id);


--
-- Name: publication publication_route_realm_id_publication_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_route_realm_id_publication_id_key UNIQUE (route, realm_id, publication_id);


--
-- Name: realm_ban realm_ban_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_ban
    ADD CONSTRAINT realm_ban_pkey PRIMARY KEY (route, realm_id, account_id, valid WITHOUT OVERLAPS);


--
-- Name: realm_member realm_member_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_member
    ADD CONSTRAINT realm_member_pkey PRIMARY KEY (route, realm_id, account_id, valid WITHOUT OVERLAPS);


--
-- Name: realm_member_terminal realm_member_terminal_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_member_terminal
    ADD CONSTRAINT realm_member_terminal_pkey PRIMARY KEY (route, realm_id, account_id, reservation_id);


--
-- Name: realm_membership_operation realm_membership_operation_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_membership_operation
    ADD CONSTRAINT realm_membership_operation_pkey PRIMARY KEY (route, operation_id);


--
-- Name: realm_membership_proof realm_membership_proof_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_membership_proof
    ADD CONSTRAINT realm_membership_proof_pkey PRIMARY KEY (route, realm_id, account_id, generation_id);


--
-- Name: realm_membership_proof realm_membership_proof_route_realm_id_account_id_operation__key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_membership_proof
    ADD CONSTRAINT realm_membership_proof_route_realm_id_account_id_operation__key UNIQUE (route, realm_id, account_id, operation_id);


--
-- Name: realm realm_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_pkey PRIMARY KEY (route, realm_id);


--
-- Name: realm_revision realm_revision_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_pkey PRIMARY KEY (route, revision_id);


--
-- Name: realm_revision realm_revision_route_realm_id_revision_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_revision_id_key UNIQUE (route, realm_id, revision_id);


--
-- Name: realm_revision realm_revision_route_realm_id_revision_id_visibility_contex_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_revision_id_visibility_contex_key UNIQUE (route, realm_id, revision_id, visibility, context_id);


--
-- Name: realm realm_route_space_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_route_space_id_key UNIQUE (route, space_id);


--
-- Name: revision_locator revision_locator_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.revision_locator
    ADD CONSTRAINT revision_locator_pkey PRIMARY KEY (route, account_id, kind, owner_route, owner_id, revision_id);


--
-- Name: space_address_claim space_address_claim_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_address_claim
    ADD CONSTRAINT space_address_claim_pkey PRIMARY KEY (route, normalized_address);


--
-- Name: space space_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space
    ADD CONSTRAINT space_pkey PRIMARY KEY (route, space_id);


--
-- Name: space_revision space_revision_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_pkey PRIMARY KEY (route, revision_id);


--
-- Name: space_revision space_revision_route_space_id_revision_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_route_space_id_revision_id_key UNIQUE (route, space_id, revision_id);


--
-- Name: publication_head_adopted_page; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX publication_head_adopted_page ON community.publication_head USING btree (route, realm_id, published_at DESC, subject_id DESC) WHERE (verdict = 'adopt'::text);


--
-- Name: realm_ban_current; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX realm_ban_current ON community.realm_ban USING btree (route, realm_id, account_id) INCLUDE (valid) WHERE upper_inf(valid);


--
-- Name: realm_member_change; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX realm_member_change ON community.realm_member USING btree (route, realm_id, account_id, transaction_id);


--
-- Name: realm_member_next; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_next ON community.realm_member USING btree (route, realm_id, account_id, lower(valid)) WHERE (NOT lower_inf(valid));


--
-- Name: realm_member_open; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX realm_member_open ON community.realm_member USING btree (route, realm_id, account_id) WHERE upper_inf(valid);


--
-- Name: realm_member_reservation; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_reservation ON community.realm_member USING btree (route, realm_id, account_id, reservation_id);


--
-- Name: realm_member_key_mcv; Type: STATISTICS; Schema: community; Owner: -
--

CREATE STATISTICS community.realm_member_key_mcv (mcv) ON route, realm_id, account_id FROM community.realm_member;


--
-- Name: publication_head publication_head_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER publication_head_identity BEFORE UPDATE ON community.publication_head FOR EACH ROW EXECUTE FUNCTION community.guard_publication_head();


--
-- Name: publication publication_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER publication_immutable BEFORE DELETE OR UPDATE ON community.publication FOR EACH ROW EXECUTE FUNCTION community.guard_publication();


--
-- Name: realm realm_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_identity BEFORE UPDATE ON community.realm FOR EACH ROW EXECUTE FUNCTION community.guard_realm();


--
-- Name: realm_member_terminal realm_member_terminal_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_member_terminal_immutable BEFORE DELETE OR UPDATE ON community.realm_member_terminal FOR EACH ROW EXECUTE FUNCTION community.guard_realm_member_terminal();


--
-- Name: realm_membership_operation realm_membership_operation_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_membership_operation_immutable BEFORE DELETE OR UPDATE ON community.realm_membership_operation FOR EACH ROW EXECUTE FUNCTION community.guard_realm_membership_operation();


--
-- Name: realm_membership_proof realm_membership_proof_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_membership_proof_immutable BEFORE DELETE OR UPDATE ON community.realm_membership_proof FOR EACH ROW EXECUTE FUNCTION community.guard_realm_member_terminal();


--
-- Name: realm_revision realm_revision_board_scheme; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_revision_board_scheme BEFORE INSERT ON community.realm_revision FOR EACH ROW WHEN (((new.board_scheme_id IS NULL) AND (new.predecessor IS NOT NULL))) EXECUTE FUNCTION community.inherit_realm_board_scheme();


--
-- Name: realm_revision realm_revision_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_revision_immutable BEFORE DELETE OR UPDATE ON community.realm_revision FOR EACH ROW EXECUTE FUNCTION community.guard_realm_revision();


--
-- Name: realm_revision realm_revision_votes; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_revision_votes BEFORE INSERT ON community.realm_revision FOR EACH ROW WHEN (((new.predecessor IS NOT NULL) AND (new.votes = '{"upvote": 1, "downvote": -1}'::jsonb))) EXECUTE FUNCTION community.inherit_realm_votes();


--
-- Name: space space_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_identity BEFORE UPDATE ON community.space FOR EACH ROW EXECUTE FUNCTION community.guard_space();


--
-- Name: space_revision space_revision_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_revision_immutable BEFORE DELETE OR UPDATE ON community.space_revision FOR EACH ROW EXECUTE FUNCTION community.guard_space_revision();


--
-- Name: publication_head publication_head_route_publication_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication_head
    ADD CONSTRAINT publication_head_route_publication_id_fkey FOREIGN KEY (route, publication_id) REFERENCES community.publication(route, publication_id);


--
-- Name: publication_head publication_head_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication_head
    ADD CONSTRAINT publication_head_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: publication publication_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: publication publication_route_realm_id_predecessor_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_route_realm_id_predecessor_fkey FOREIGN KEY (route, realm_id, predecessor) REFERENCES community.publication(route, realm_id, publication_id);


--
-- Name: realm realm_head_revision_fk; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_head_revision_fk FOREIGN KEY (route, realm_id, head_revision_id, visibility, context_id) REFERENCES community.realm_revision(route, realm_id, revision_id, visibility, context_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: realm_revision realm_revision_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: realm_revision realm_revision_route_realm_id_predecessor_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_predecessor_fkey FOREIGN KEY (route, realm_id, predecessor) REFERENCES community.realm_revision(route, realm_id, revision_id);


--
-- Name: realm realm_route_space_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_route_space_id_fkey FOREIGN KEY (route, space_id) REFERENCES community.space(route, space_id);


--
-- Name: space space_head_revision_fk; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space
    ADD CONSTRAINT space_head_revision_fk FOREIGN KEY (route, space_id, head_revision_id) REFERENCES community.space_revision(route, space_id, revision_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: space_revision space_revision_route_space_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_route_space_id_fkey FOREIGN KEY (route, space_id) REFERENCES community.space(route, space_id);


--
-- Name: space_revision space_revision_route_space_id_predecessor_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_route_space_id_predecessor_fkey FOREIGN KEY (route, space_id, predecessor) REFERENCES community.space_revision(route, space_id, revision_id);


--
CREATE FUNCTION community.guard_realm_orphan_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.ownership_state = 'orphaned' AND NEW.ownership_state = 'orphaned'
     AND ROW(NEW.orphaned_at, NEW.claim_eligible_at) IS DISTINCT FROM ROW(OLD.orphaned_at, OLD.claim_eligible_at) THEN
    RAISE EXCEPTION 'An orphaned Realm retains its original claim deadline' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_orphan_deadline BEFORE UPDATE ON community.realm
  FOR EACH ROW EXECUTE FUNCTION community.guard_realm_orphan_deadline();

CREATE TABLE community.realm_claim_request (
  route integer NOT NULL,
  realm_id uuid NOT NULL,
  request_id uuid NOT NULL,
  account_id uuid NOT NULL,
  orphaned_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved')),
  approved_at timestamptz,
  CONSTRAINT realm_claim_request_approval_check CHECK (
    (state = 'pending' AND approved_at IS NULL)
    OR (state = 'approved' AND approved_at IS NOT NULL AND isfinite(approved_at) AND approved_at >= requested_at)
  ),
  PRIMARY KEY (route, realm_id, request_id),
  UNIQUE (route, realm_id, orphaned_at, account_id),
  FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id),
  CHECK (route = ((get_byte(uuid_send(request_id), 10) * 256) + get_byte(uuid_send(request_id), 11)))
);


-- PostgreSQL database dump complete
--



ALTER TABLE community.realm
  ADD COLUMN discovery_epoch bigint NOT NULL DEFAULT 1 CHECK (discovery_epoch > 0),
  ADD COLUMN discovery_epoch_started_at timestamptz NOT NULL DEFAULT clock_timestamp();

-- All native Realm head writers share this guard. Metadata edits retain the epoch.
CREATE FUNCTION community.advance_realm_discovery_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.discovery_epoch_started_at := NEW.created_at;
  ELSIF (NEW.visibility, NEW.state, NEW.space_id) IS DISTINCT FROM
        (OLD.visibility, OLD.state, OLD.space_id) THEN
    NEW.discovery_epoch := OLD.discovery_epoch + 1;
    IF NEW.head_revision_id IS DISTINCT FROM OLD.head_revision_id THEN
      -- Native visibility changes append this exact revision at command T.
      SELECT r.created_at INTO STRICT NEW.discovery_epoch_started_at
      FROM community.realm_revision r
      WHERE r.route = NEW.route AND r.realm_id = NEW.realm_id
        AND r.revision_id = NEW.head_revision_id;
    ELSE
      NEW.discovery_epoch_started_at := clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_discovery_epoch BEFORE INSERT OR UPDATE ON community.realm
FOR EACH ROW EXECUTE FUNCTION community.advance_realm_discovery_epoch();

ALTER TABLE community.realm ADD COLUMN discovery_generation bigint NOT NULL DEFAULT 1
  CHECK (discovery_generation > 0);

CREATE TABLE community.realm_discovery_fence (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  realm_epoch bigint NOT NULL CHECK (realm_epoch > 0),
  source_route integer NOT NULL CHECK (source_route BETWEEN 0 AND 65535),
  intent text NOT NULL CHECK (intent ~ '^[0-9a-f]{64}$'),
  generation bigint NOT NULL CHECK (generation > 0),
  fence_generation bigint NOT NULL CHECK (fence_generation > 0),
  outcome text CHECK (outcome IN ('applied','aborted')),
  outcome_transaction_id uuid,
  PRIMARY KEY (route, realm_id, realm_epoch, source_route, intent, generation),
  FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id),
  CHECK ((outcome IS NULL) = (outcome_transaction_id IS NULL))
);
CREATE INDEX realm_discovery_fence_pending ON community.realm_discovery_fence
  (route, realm_id, realm_epoch) WHERE outcome IS NULL;

-- Absolute versioned source state, ready for Community's later bounded bucket consumer.
CREATE TABLE community.realm_discovery_source (
  route integer NOT NULL,
  realm_id uuid NOT NULL,
  realm_epoch bigint NOT NULL,
  source_route integer NOT NULL,
  thread_id uuid NOT NULL,
  board_id uuid NOT NULL,
  creation_day date NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  contributing boolean NOT NULL,
  PRIMARY KEY (route, realm_id, realm_epoch, source_route, thread_id)
);
CREATE TABLE community.realm_discovery_board (
  route integer NOT NULL,
  realm_id uuid NOT NULL,
  realm_epoch bigint NOT NULL,
  board_id uuid NOT NULL,
  source_version bigint NOT NULL CHECK (source_version > 0),
  published boolean NOT NULL,
  PRIMARY KEY (route, realm_id, realm_epoch, board_id)
);

CREATE FUNCTION community.fence_realm_discovery_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.visibility, NEW.state, NEW.space_id) IS DISTINCT FROM
     (OLD.visibility, OLD.state, OLD.space_id) THEN
    NEW.discovery_generation := OLD.discovery_generation + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER realm_discovery_generation BEFORE UPDATE ON community.realm
FOR EACH ROW EXECUTE FUNCTION community.fence_realm_discovery_epoch();

-- A Space carries at most one Realm in the same route (the unique native slot).
-- State changes invalidate that binding atomically, without a descendant scan.
CREATE FUNCTION community.fence_space_realm_discovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    UPDATE community.realm SET discovery_epoch = discovery_epoch + 1,
      discovery_epoch_started_at = clock_timestamp(), discovery_generation = discovery_generation + 1
    WHERE route = NEW.route AND space_id = NEW.space_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER space_realm_discovery_generation AFTER UPDATE ON community.space
FOR EACH ROW EXECUTE FUNCTION community.fence_space_realm_discovery();

-- No historical source backfill: only committed native changes enter this log.
ALTER TABLE community.realm DROP CONSTRAINT realm_discovery_generation_check;
ALTER TABLE community.realm ALTER COLUMN discovery_generation SET DEFAULT 0;
ALTER TABLE community.realm ADD CHECK (discovery_generation >= 0);
ALTER TABLE community.realm_discovery_source ADD COLUMN space_id uuid;

CREATE TABLE community.realm_discovery_change (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  realm_id uuid NOT NULL,
  realm_epoch bigint NOT NULL CHECK (realm_epoch > 0),
  generation bigint NOT NULL CHECK (generation > 0),
  previous_generation bigint NOT NULL CHECK (previous_generation >= 0),
  transaction_id uuid NOT NULL,
  value jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object' AND value->>'kind' IN ('thread','board','epoch','gate')),
  PRIMARY KEY (route, realm_id, generation),
  FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id),
  CHECK (generation = previous_generation + 1)
);

CREATE FUNCTION community.immutable_realm_discovery_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Realm discovery changes are append-only';
END;
$$;
CREATE TRIGGER realm_discovery_change_immutable BEFORE UPDATE OR DELETE ON community.realm_discovery_change
FOR EACH ROW EXECUTE FUNCTION community.immutable_realm_discovery_change();

-- The generation is owned by the log alone. Epoch guards still change the epoch
-- immediately; their deferred log entry and generation commit atomically with it.
CREATE OR REPLACE FUNCTION community.fence_realm_discovery_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION community.fence_space_realm_discovery() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    UPDATE community.realm SET discovery_epoch = discovery_epoch + 1,
      discovery_epoch_started_at = clock_timestamp()
    WHERE route = NEW.route AND space_id = NEW.space_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION community.append_realm_discovery_change(
  source_route integer, source_realm uuid, source_epoch bigint, change_value jsonb
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  prior bigint;
  native_transaction uuid;
BEGIN
  -- Installed only by bindRealmDiscoveryCommand's native executor callback.
  native_transaction := NULLIF(current_setting('rezics.discovery_transaction_id', true), '')::uuid;
  IF native_transaction IS NULL THEN
    RAISE EXCEPTION 'Realm discovery native command binding unavailable';
  END IF;
  SELECT discovery_generation INTO STRICT prior FROM community.realm
    WHERE route = source_route AND realm_id = source_realm FOR UPDATE;
  INSERT INTO community.realm_discovery_change
    (route,realm_id,realm_epoch,generation,previous_generation,transaction_id,value)
    VALUES (source_route,source_realm,source_epoch,prior+1,prior,native_transaction,change_value);
  UPDATE community.realm SET discovery_generation = prior+1
    WHERE route = source_route AND realm_id = source_realm;
END;
$$;

CREATE FUNCTION community.log_realm_discovery_thread() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.space_id IS NULL THEN
    RAISE EXCEPTION 'Realm discovery original Space binding unavailable';
  END IF;
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, NEW.realm_epoch,
    jsonb_build_object('kind','thread','source',jsonb_build_object(
      'realmId',NEW.realm_id,'realmEpoch',NEW.realm_epoch::text,'spaceId',NEW.space_id,
      'boardId',NEW.board_id,'threadId',NEW.thread_id,'sourceRoute',NEW.source_route,
      'creationDay',to_char(NEW.creation_day,'YYYY-MM-DD'),'sourceVersion',NEW.source_version::text,
      'contributing',NEW.contributing)));
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER realm_discovery_thread_log AFTER INSERT OR UPDATE ON community.realm_discovery_source
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.log_realm_discovery_thread();

CREATE FUNCTION community.log_realm_discovery_board() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, NEW.realm_epoch,
    jsonb_build_object('kind','board','boardId',NEW.board_id,
      'sourceVersion',NEW.source_version::text,'published',NEW.published));
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER realm_discovery_board_log AFTER INSERT OR UPDATE ON community.realm_discovery_board
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.log_realm_discovery_board();

CREATE FUNCTION community.log_realm_discovery_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_epoch bigint;
  settled boolean;
BEGIN
  SELECT discovery_epoch INTO STRICT current_epoch FROM community.realm
    WHERE route = NEW.route AND realm_id = NEW.realm_id FOR UPDATE;
  SELECT NOT EXISTS (SELECT 1 FROM community.realm_discovery_fence
    WHERE route = NEW.route AND realm_id = NEW.realm_id AND realm_epoch = current_epoch AND outcome IS NULL)
    INTO settled;
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, current_epoch,
    jsonb_build_object('kind','gate','settled',settled));
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER realm_discovery_gate_log AFTER INSERT OR UPDATE ON community.realm_discovery_fence
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION community.log_realm_discovery_gate();

CREATE FUNCTION community.log_realm_discovery_epoch() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM community.append_realm_discovery_change(NEW.route, NEW.realm_id, NEW.discovery_epoch,
    jsonb_build_object('kind','epoch'));
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER realm_discovery_epoch_log AFTER UPDATE ON community.realm
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (OLD.discovery_epoch IS DISTINCT FROM NEW.discovery_epoch)
EXECUTE FUNCTION community.log_realm_discovery_epoch();
-- One explicit routed derived-index home. Source homes remain independent authorities.
CREATE TABLE community.discovery_anchor (
  route integer PRIMARY KEY CHECK (route = 0),
  publication_epoch bigint NOT NULL DEFAULT 1 CHECK (publication_epoch > 0)
);
CREATE TABLE community.discovery_realm (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL,
  realm_epoch text NOT NULL, applied_generation bigint NOT NULL CHECK (applied_generation >= 0),
  settled boolean NOT NULL DEFAULT false, cutoff date NOT NULL,
  popular bigint NOT NULL DEFAULT 0 CHECK (popular >= 0),
  trending bigint NOT NULL DEFAULT 0 CHECK (trending >= 0),
  PRIMARY KEY (route, realm_id)
);
CREATE INDEX discovery_popular ON community.discovery_realm (route, (-popular), realm_id) WHERE popular > 0;
CREATE INDEX discovery_trending ON community.discovery_realm (route, (-trending), realm_id) WHERE trending > 0;
CREATE TABLE community.discovery_board (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL, realm_epoch text NOT NULL,
  board_id uuid NOT NULL, source_version text NOT NULL,
  published boolean NOT NULL,
  PRIMARY KEY (route, realm_id, realm_epoch, board_id)
);
CREATE TABLE community.discovery_thread (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL, realm_epoch text NOT NULL,
  thread_id uuid NOT NULL, board_id uuid NOT NULL, space_id uuid NOT NULL, source_route integer NOT NULL,
  creation_day date NOT NULL, source_version text NOT NULL,
  contributing boolean NOT NULL,
  PRIMARY KEY (route, realm_id, realm_epoch, thread_id)
);
CREATE TABLE community.discovery_bucket (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL, realm_epoch text NOT NULL,
  board_id uuid NOT NULL, creation_day date NOT NULL, count bigint NOT NULL CHECK (count >= 0),
  PRIMARY KEY (route, realm_id, realm_epoch, board_id, creation_day)
);
CREATE TABLE community.discovery_day (
  route integer NOT NULL CHECK (route = 0), realm_id uuid NOT NULL, creation_day date NOT NULL,
  count bigint NOT NULL CHECK (count >= 0), PRIMARY KEY (route, realm_id, creation_day)
);
-- Every cleanup/rollover key is installed by its write, never discovered through a sweep.
CREATE TABLE community.discovery_due (
  route integer NOT NULL CHECK (route = 0), kind text NOT NULL CHECK (kind IN ('realm','bucket','thread','board')),
  realm_id uuid NOT NULL, realm_epoch text NOT NULL, key uuid NOT NULL, day date NOT NULL,
  due_at timestamptz NOT NULL CHECK (isfinite(due_at)),
  PRIMARY KEY (route, kind, realm_id, realm_epoch, key, day)
);
CREATE INDEX discovery_due_frontier ON community.discovery_due (route, due_at, kind, realm_id, realm_epoch, key, day);

