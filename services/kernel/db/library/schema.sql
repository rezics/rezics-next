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
-- Name: library; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA library;


--
-- Name: guard_follow_target_type(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_follow_target_type() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.target_type IS DISTINCT FROM OLD.target_type THEN
    RAISE EXCEPTION 'Follow target type cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_type_preparation_header(); Type: FUNCTION; Schema: library; Owner: -
--

CREATE FUNCTION library.guard_type_preparation_header() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Type preparation headers are immutable' USING ERRCODE = '23514';
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bulk_effect; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.bulk_effect (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    ordinal bigint NOT NULL,
    target_anchor_id uuid NOT NULL,
    account_id uuid NOT NULL,
    source_route integer NOT NULL,
    source_id uuid NOT NULL,
    source_digest text NOT NULL,
    target jsonb NOT NULL,
    receipt jsonb NOT NULL,
    command_kind text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest text NOT NULL,
    transaction_id uuid NOT NULL,
    outcome text NOT NULL,
    reason text,
    resulting_member_id uuid,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT bulk_effect_check CHECK ((route = ((get_byte(uuid_send(target_anchor_id), 10) * 256) + get_byte(uuid_send(target_anchor_id), 11)))),
    CONSTRAINT bulk_effect_check1 CHECK ((source_route = ((get_byte(uuid_send(source_id), 10) * 256) + get_byte(uuid_send(source_id), 11)))),
    CONSTRAINT bulk_effect_command_kind_check CHECK (((char_length(command_kind) >= 1) AND (char_length(command_kind) <= 255))),
    CONSTRAINT bulk_effect_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255))),
    CONSTRAINT bulk_effect_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT bulk_effect_outcome_check CHECK ((outcome = ANY (ARRAY['applied'::text, 'no_effect'::text, 'conflict'::text, 'denied'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT bulk_effect_reason_check CHECK ((reason = ANY (ARRAY['revision_mismatch'::text, 'incarnation_mismatch'::text, 'missing_target'::text, 'authority_lost'::text, 'target_denied'::text, 'collection_full'::text, 'invalid_subject'::text, 'dependency_unavailable'::text, 'deadline'::text, 'cancel_requested'::text, 'evidence_missing'::text, 'execution_expired'::text]))),
    CONSTRAINT bulk_effect_receipt_check CHECK ((jsonb_typeof(receipt) = 'object'::text)),
    CONSTRAINT bulk_effect_request_digest_check CHECK ((request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT bulk_effect_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT bulk_effect_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT bulk_effect_source_route_check CHECK (((source_route >= 0) AND (source_route <= 65535))),
    CONSTRAINT bulk_effect_target_check CHECK ((jsonb_typeof(target) = 'object'::text))
);


--
-- Name: bulk_target; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.bulk_target (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    ordinal bigint NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    target_kind text NOT NULL,
    collection_id uuid,
    member_id uuid,
    target jsonb NOT NULL,
    source_digest text NOT NULL,
    receipt jsonb NOT NULL,
    created_transaction_id uuid NOT NULL,
    state text NOT NULL,
    reason text,
    resulting_member_id uuid,
    evidence jsonb,
    chunk_index integer NOT NULL,
    CONSTRAINT bulk_target_check CHECK ((route = ((get_byte(uuid_send(operation_id), 10) * 256) + get_byte(uuid_send(operation_id), 11)))),
    CONSTRAINT bulk_target_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT bulk_target_check2 CHECK ((((target_kind = 'subject'::text) AND (collection_id IS NULL) AND (member_id IS NULL)) OR ((target_kind = 'occurrence'::text) AND (collection_id IS NOT NULL) AND (member_id IS NOT NULL)))),
    CONSTRAINT bulk_target_check3 CHECK ((((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)) = ((get_byte(uuid_send(member_id), 10) * 256) + get_byte(uuid_send(member_id), 11)))),
    CONSTRAINT bulk_target_chunk_index_check CHECK ((chunk_index >= 0)),
    CONSTRAINT bulk_target_evidence_check CHECK ((jsonb_typeof(evidence) = 'object'::text)),
    CONSTRAINT bulk_target_ordinal_check CHECK ((ordinal >= 0)),
    CONSTRAINT bulk_target_reason_check CHECK ((reason = ANY (ARRAY['revision_mismatch'::text, 'incarnation_mismatch'::text, 'missing_target'::text, 'authority_lost'::text, 'target_denied'::text, 'collection_full'::text, 'invalid_subject'::text, 'dependency_unavailable'::text, 'deadline'::text, 'cancel_requested'::text, 'evidence_missing'::text, 'execution_expired'::text]))),
    CONSTRAINT bulk_target_receipt_check CHECK ((jsonb_typeof(receipt) = 'object'::text)),
    CONSTRAINT bulk_target_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT bulk_target_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT bulk_target_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'reconciling'::text, 'applied'::text, 'no_effect'::text, 'conflict'::text, 'denied'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT bulk_target_target_check CHECK ((jsonb_typeof(target) = 'object'::text)),
    CONSTRAINT bulk_target_target_kind_check CHECK ((target_kind = ANY (ARRAY['subject'::text, 'occurrence'::text])))
);


--
-- Name: collection; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    curator_account_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    visibility text NOT NULL,
    state text NOT NULL,
    revision integer NOT NULL,
    member_count integer DEFAULT 0 NOT NULL,
    order_epoch integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT collection_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_check1 CHECK ((route = ((get_byte(uuid_send(curator_account_id), 10) * 256) + get_byte(uuid_send(curator_account_id), 11)))),
    CONSTRAINT collection_description_check CHECK (((description IS NULL) OR (char_length(description) <= 2000))),
    CONSTRAINT collection_member_count_check CHECK (((member_count >= 0) AND (member_count <= 5000))),
    CONSTRAINT collection_order_epoch_check CHECK ((order_epoch >= 0)),
    CONSTRAINT collection_revision_check CHECK ((revision >= 1)),
    CONSTRAINT collection_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT collection_state_check CHECK ((state = ANY (ARRAY['active'::text, 'deleted'::text]))),
    CONSTRAINT collection_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT collection_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'unlisted'::text, 'public'::text])))
);


--
-- Name: collection_member; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.collection_member (
    route integer NOT NULL,
    collection_id uuid NOT NULL,
    member_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    note text,
    ordinal_key text NOT NULL COLLATE pg_catalog."C",
    added_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT collection_member_check CHECK ((route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT collection_member_check1 CHECK ((route = ((get_byte(uuid_send(member_id), 10) * 256) + get_byte(uuid_send(member_id), 11)))),
    CONSTRAINT collection_member_note_check CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT collection_member_ordinal_key_check CHECK (((char_length(ordinal_key) >= 1) AND (char_length(ordinal_key) <= 48))),
    CONSTRAINT collection_member_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: copy; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.copy (
    route integer NOT NULL,
    copy_id uuid NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    status text NOT NULL,
    location text,
    source text,
    acquired_on date,
    disposed_on date,
    note text,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT copy_check CHECK ((route = ((get_byte(uuid_send(copy_id), 10) * 256) + get_byte(uuid_send(copy_id), 11)))),
    CONSTRAINT copy_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT copy_location_check CHECK (((location IS NULL) OR (char_length(location) <= 200))),
    CONSTRAINT copy_note_check CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT copy_revision_check CHECK ((revision >= 1)),
    CONSTRAINT copy_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT copy_source_check CHECK (((source IS NULL) OR (char_length(source) <= 200))),
    CONSTRAINT copy_status_check CHECK ((status = ANY (ARRAY['ordered'::text, 'owned'::text, 'lent'::text, 'disposed'::text])))
);


--
-- Name: entry; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.entry (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    requested_subject_id uuid,
    state text NOT NULL,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    activity_at timestamp with time zone,
    finished_at timestamp with time zone,
    type_id uuid,
    type_source_id uuid,
    type_source_partition integer,
    type_source_epoch integer,
    type_source_position bigint,
    incarnation_id uuid,
    CONSTRAINT entry_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT entry_revision_check CHECK ((revision >= 1)),
    CONSTRAINT entry_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT entry_state_check CHECK ((state = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'paused'::text, 'dropped'::text]))),
    CONSTRAINT entry_type_observation_check CHECK ((((type_id IS NULL) AND (type_source_id IS NULL) AND (type_source_partition IS NULL) AND (type_source_epoch IS NULL) AND (type_source_position IS NULL)) OR ((type_id IS NOT NULL) AND (type_source_id IS NOT NULL) AND (type_source_partition IS NOT NULL) AND (type_source_epoch IS NOT NULL) AND (type_source_position IS NOT NULL) AND ((type_source_partition >= 0) AND (type_source_partition <= 4095)) AND (type_source_epoch >= 1) AND (type_source_position >= 0) AND (type_source_partition = (((get_byte(uuid_send(type_source_id), 10) * 256) + get_byte(uuid_send(type_source_id), 11)) >> 4)))))
);


--
-- Name: follow; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.follow (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    target_id uuid NOT NULL,
    target_type text NOT NULL,
    state text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT follow_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT follow_check1 CHECK (((reason = 'explicit'::text) OR (state = 'following'::text))),
    CONSTRAINT follow_reason_check CHECK ((reason = ANY (ARRAY['explicit'::text, 'library'::text, 'membership'::text]))),
    CONSTRAINT follow_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT follow_state_check CHECK ((state = ANY (ARRAY['following'::text, 'unfollowed'::text]))),
    CONSTRAINT follow_target_type_check CHECK ((target_type = ANY (ARRAY['subject'::text, 'collection'::text, 'space'::text])))
);


--
-- Name: progress_change; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_change (
    route integer NOT NULL,
    session_id uuid NOT NULL,
    change_no integer NOT NULL,
    intent jsonb NOT NULL,
    recorded_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT progress_change_change_no_check CHECK ((change_no >= 1)),
    CONSTRAINT progress_change_check CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT progress_change_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: progress_head; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_head (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    last_changed_at timestamp with time zone,
    last_completed_at timestamp with time zone,
    CONSTRAINT progress_head_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT progress_head_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: progress_session; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_session (
    route integer NOT NULL,
    session_id uuid NOT NULL,
    account_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    version_subject_id uuid,
    mode text NOT NULL,
    unit text NOT NULL,
    total numeric,
    amount numeric,
    locator text,
    "position" numeric,
    completed_unit_count integer NOT NULL,
    state text NOT NULL,
    revision integer NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    transaction_id uuid NOT NULL,
    last_changed_at timestamp with time zone,
    CONSTRAINT progress_session_amount_check CHECK (((amount IS NULL) OR (amount >= (0)::numeric))),
    CONSTRAINT progress_session_check CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT progress_session_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT progress_session_check2 CHECK (((unit <> 'percent'::text) OR (((amount IS NULL) OR (amount <= (100)::numeric)) AND ((total IS NULL) OR (total <= (100)::numeric))))),
    CONSTRAINT progress_session_check3 CHECK (((state = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT progress_session_check4 CHECK ((((mode = 'scalar_amount'::text) AND (locator IS NULL) AND ("position" IS NULL) AND (completed_unit_count = 0)) OR ((mode = 'cursor_position'::text) AND (amount IS NULL) AND (total IS NULL) AND (completed_unit_count = 0) AND (((locator IS NULL) AND ("position" IS NULL)) OR ((locator IS NOT NULL) AND ("position" IS NOT NULL)))) OR ((mode = 'completed_units'::text) AND (amount IS NULL) AND (total IS NULL) AND (locator IS NULL) AND ("position" IS NULL)))),
    CONSTRAINT progress_session_completed_unit_count_check CHECK (((completed_unit_count >= 0) AND (completed_unit_count <= 20000))),
    CONSTRAINT progress_session_locator_check CHECK (((locator IS NULL) OR ((char_length(locator) >= 1) AND (char_length(locator) <= 256)))),
    CONSTRAINT progress_session_mode_check CHECK ((mode = ANY (ARRAY['scalar_amount'::text, 'cursor_position'::text, 'completed_units'::text]))),
    CONSTRAINT progress_session_position_check CHECK ((("position" IS NULL) OR ("position" >= (0)::numeric))),
    CONSTRAINT progress_session_revision_check CHECK ((revision >= 1)),
    CONSTRAINT progress_session_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT progress_session_state_check CHECK ((state = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text]))),
    CONSTRAINT progress_session_total_check CHECK (((total IS NULL) OR (total >= (0)::numeric))),
    CONSTRAINT progress_session_unit_check CHECK ((unit = ANY (ARRAY['page'::text, 'chapter'::text, 'episode'::text, 'volume'::text, 'minute'::text, 'percent'::text])))
);


--
-- Name: progress_unit; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.progress_unit (
    route integer NOT NULL,
    session_id uuid NOT NULL,
    unit_id text NOT NULL,
    added_at timestamp with time zone NOT NULL,
    CONSTRAINT progress_unit_check CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT progress_unit_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT progress_unit_unit_id_check CHECK (((char_length(unit_id) >= 1) AND (char_length(unit_id) <= 128)))
);


--
-- Name: published_log; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.published_log (
    route integer NOT NULL,
    log_id uuid NOT NULL,
    account_id uuid NOT NULL,
    session_id uuid,
    subject_id uuid NOT NULL,
    session_state text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    note text,
    published_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT published_log_check CHECK ((route = ((get_byte(uuid_send(log_id), 10) * 256) + get_byte(uuid_send(log_id), 11)))),
    CONSTRAINT published_log_check1 CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT published_log_check2 CHECK ((route = ((get_byte(uuid_send(session_id), 10) * 256) + get_byte(uuid_send(session_id), 11)))),
    CONSTRAINT published_log_check3 CHECK (((session_state = 'completed'::text) = (completed_at IS NOT NULL))),
    CONSTRAINT published_log_note_check CHECK (((note IS NULL) OR ((char_length(note) >= 0) AND (char_length(note) <= 1000)))),
    CONSTRAINT published_log_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT published_log_session_state_check CHECK ((session_state = ANY (ARRAY['active'::text, 'completed'::text, 'abandoned'::text])))
);


--
-- Name: shelf_count; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_count (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    bucket text NOT NULL,
    type_id uuid NOT NULL,
    n bigint NOT NULL,
    CONSTRAINT shelf_count_bucket_check CHECK ((bucket = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'paused'::text, 'dropped'::text, 'all'::text, 'collections'::text]))),
    CONSTRAINT shelf_count_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_count_check1 CHECK (((bucket <> 'collections'::text) OR (type_id = '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT shelf_count_n_check CHECK ((n >= 0)),
    CONSTRAINT shelf_count_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: shelf_type_node; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_type_node (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    node_id uuid NOT NULL,
    parent_id uuid NOT NULL,
    chunk bytea NOT NULL,
    terminal_type_id uuid,
    CONSTRAINT shelf_type_node_account_route_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_type_node_chunk_length_check CHECK (((octet_length(chunk) >= 1) AND (octet_length(chunk) <= 256))),
    CONSTRAINT shelf_type_node_node_id_non_nil_check CHECK ((node_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_node_node_id_route_check CHECK ((route = ((get_byte(uuid_send(node_id), 10) * 256) + get_byte(uuid_send(node_id), 11)))),
    CONSTRAINT shelf_type_node_not_self_parent_check CHECK ((node_id <> parent_id)),
    CONSTRAINT shelf_type_node_parent_id_non_nil_check CHECK ((parent_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_node_parent_id_route_check CHECK ((route = ((get_byte(uuid_send(parent_id), 10) * 256) + get_byte(uuid_send(parent_id), 11)))),
    CONSTRAINT shelf_type_node_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT shelf_type_node_terminal_type_id_non_nil_check CHECK (((terminal_type_id IS NULL) OR (terminal_type_id <> '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT shelf_type_node_terminal_type_id_route_check CHECK (((terminal_type_id IS NULL) OR (route = ((get_byte(uuid_send(terminal_type_id), 10) * 256) + get_byte(uuid_send(terminal_type_id), 11)))))
);


--
-- Name: TABLE shelf_type_node; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.shelf_type_node IS 'Radix nodes and terminals are scoped by route and account_id and retained until explicit account erasure.';


--
-- Name: shelf_type_reservation; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_type_reservation (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    full_type text NOT NULL,
    digest bytea NOT NULL,
    candidate_type_id uuid NOT NULL,
    node_id uuid NOT NULL,
    byte_offset bigint NOT NULL,
    fence_id uuid NOT NULL,
    generation_id uuid NOT NULL,
    CONSTRAINT shelf_type_reservation_account_route_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_type_reservation_byte_offset_check CHECK (((byte_offset >= 0) AND (byte_offset <= octet_length(full_type)))),
    CONSTRAINT shelf_type_reservation_candidate_type_id_non_nil_check CHECK ((candidate_type_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_candidate_type_id_route_check CHECK ((route = ((get_byte(uuid_send(candidate_type_id), 10) * 256) + get_byte(uuid_send(candidate_type_id), 11)))),
    CONSTRAINT shelf_type_reservation_digest_length_check CHECK ((octet_length(digest) = 32)),
    CONSTRAINT shelf_type_reservation_fence_id_non_nil_check CHECK ((fence_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_fence_id_route_check CHECK ((route = ((get_byte(uuid_send(fence_id), 10) * 256) + get_byte(uuid_send(fence_id), 11)))),
    CONSTRAINT shelf_type_reservation_generation_id_non_nil_check CHECK ((generation_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_generation_id_route_check CHECK ((route = ((get_byte(uuid_send(generation_id), 10) * 256) + get_byte(uuid_send(generation_id), 11)))),
    CONSTRAINT shelf_type_reservation_id_non_nil_check CHECK ((reservation_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_id_route_check CHECK ((route = ((get_byte(uuid_send(reservation_id), 10) * 256) + get_byte(uuid_send(reservation_id), 11)))),
    CONSTRAINT shelf_type_reservation_node_id_non_nil_check CHECK ((node_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_reservation_node_id_route_check CHECK ((route = ((get_byte(uuid_send(node_id), 10) * 256) + get_byte(uuid_send(node_id), 11)))),
    CONSTRAINT shelf_type_reservation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE shelf_type_reservation; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.shelf_type_reservation IS 'Staging reservations are scoped by route and account_id.';


--
-- Name: shelf_type_root; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_type_root (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    digest bytea NOT NULL,
    primary_type_id uuid NOT NULL,
    root_node_id uuid NOT NULL,
    CONSTRAINT shelf_type_root_account_route_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_type_root_digest_length_check CHECK ((octet_length(digest) = 32)),
    CONSTRAINT shelf_type_root_node_id_non_nil_check CHECK ((root_node_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_root_node_id_route_check CHECK ((route = ((get_byte(uuid_send(root_node_id), 10) * 256) + get_byte(uuid_send(root_node_id), 11)))),
    CONSTRAINT shelf_type_root_primary_type_id_non_nil_check CHECK ((primary_type_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_root_primary_type_id_route_check CHECK ((route = ((get_byte(uuid_send(primary_type_id), 10) * 256) + get_byte(uuid_send(primary_type_id), 11)))),
    CONSTRAINT shelf_type_root_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE shelf_type_root; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.shelf_type_root IS 'Digest roots are scoped by route and account_id and retained until explicit account erasure.';


--
-- Name: shelf_type_value; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.shelf_type_value (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    type_id uuid NOT NULL,
    full_type text NOT NULL,
    byte_length bigint NOT NULL,
    json_byte_length bigint NOT NULL,
    CONSTRAINT shelf_type_value_account_route_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT shelf_type_value_byte_length_check CHECK (((byte_length >= 0) AND (byte_length = octet_length(full_type)))),
    CONSTRAINT shelf_type_value_json_byte_length_check CHECK (((json_byte_length >= 0) AND (json_byte_length = octet_length((to_json(full_type))::text)))),
    CONSTRAINT shelf_type_value_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT shelf_type_value_type_id_non_nil_check CHECK ((type_id <> '00000000-0000-0000-0000-000000000000'::uuid)),
    CONSTRAINT shelf_type_value_type_id_route_check CHECK ((route = ((get_byte(uuid_send(type_id), 10) * 256) + get_byte(uuid_send(type_id), 11))))
);


--
-- Name: TABLE shelf_type_value; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.shelf_type_value IS 'Exact type identities are scoped by route and account_id and retained at zero use until explicit account erasure.';


--
-- Name: subject_collection; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.subject_collection (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    collection_id uuid NOT NULL,
    collection_route integer NOT NULL,
    multiplicity integer NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT subject_collection_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_collection_check1 CHECK ((collection_route = ((get_byte(uuid_send(collection_id), 10) * 256) + get_byte(uuid_send(collection_id), 11)))),
    CONSTRAINT subject_collection_collection_route_check CHECK (((collection_route >= 0) AND (collection_route <= 65535))),
    CONSTRAINT subject_collection_multiplicity_check CHECK ((multiplicity >= 1)),
    CONSTRAINT subject_collection_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_listing; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.subject_listing (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    public_collection_count integer NOT NULL,
    revision integer NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT subject_listing_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_listing_public_collection_count_check CHECK ((public_collection_count >= 0)),
    CONSTRAINT subject_listing_revision_check CHECK ((revision >= 1)),
    CONSTRAINT subject_listing_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: type_preparation_header; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.type_preparation_header (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    preparation_id uuid NOT NULL,
    binding_digest text NOT NULL,
    binding jsonb NOT NULL,
    origin jsonb NOT NULL,
    principal_namespace jsonb NOT NULL,
    reservation_id uuid,
    input_byte_length bigint NOT NULL,
    input_digest bytea NOT NULL,
    creation_transaction_id uuid NOT NULL,
    creation_receipt jsonb NOT NULL,
    creation_commitment text NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT type_preparation_header_binding_check CHECK ((jsonb_typeof(binding) = 'object'::text)),
    CONSTRAINT type_preparation_header_binding_digest_check CHECK ((binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT type_preparation_header_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT type_preparation_header_check1 CHECK ((route = ((get_byte(uuid_send(preparation_id), 10) * 256) + get_byte(uuid_send(preparation_id), 11)))),
    CONSTRAINT type_preparation_header_creation_commitment_check CHECK ((creation_commitment ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT type_preparation_header_creation_receipt_check CHECK ((jsonb_typeof(creation_receipt) = 'object'::text)),
    CONSTRAINT type_preparation_header_input_byte_length_check CHECK ((input_byte_length >= 0)),
    CONSTRAINT type_preparation_header_input_digest_check CHECK ((octet_length(input_digest) = 32)),
    CONSTRAINT type_preparation_header_origin_check CHECK ((jsonb_typeof(origin) = 'object'::text)),
    CONSTRAINT type_preparation_header_principal_namespace_check CHECK ((jsonb_typeof(principal_namespace) = 'object'::text)),
    CONSTRAINT type_preparation_header_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE type_preparation_header; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.type_preparation_header IS 'Immutable provenance storage, not authority or proof of completed effects. The authorized native creator validates exact TypePreparationBinding/Origin, the exact native creator receipt locator in creation_receipt and principal/basis namespace (no bearer or actor permission result), and commits this header with the core receipt response metadataCommitment in one owner command. Before continuation, independently verify the actual receipt digest, transaction and full allowlisted header commitment; copied or late receipt JSON is never authority. Source and subject may be remote.';


--
-- Name: COLUMN type_preparation_header.reservation_id; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_header.reservation_id IS 'No FK: the native reservation retains exact accepted text and matching immutable EXTERNAL bytes until atomic final dictionary publication/removal. Header and DBOS contain no input copy. Ready progress refers to the immutable published value; exact reservation/value text comparison is required, never only a hash.';


--
-- Name: COLUMN type_preparation_header.input_digest; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_header.input_digest IS 'Lookup acceleration only, never exact input equality evidence or authority; no new per-type cap.';


--
-- Name: COLUMN type_preparation_header.creation_commitment; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON COLUMN library.type_preparation_header.creation_commitment IS 'Commits preparation, owner, full binding, origin, principal/input association and creator receipt locator, excluding this commitment field itself. Publication and key payload remain exact native evidence.';


--
-- Name: type_preparation_progress; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.type_preparation_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    preparation_id uuid NOT NULL,
    chunk bigint DEFAULT 0 NOT NULL,
    byte_offset bigint DEFAULT 0 NOT NULL,
    node_id uuid,
    state text NOT NULL,
    type_id uuid,
    enqueue_pending boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT type_preparation_progress_byte_offset_check CHECK ((byte_offset >= 0)),
    CONSTRAINT type_preparation_progress_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT type_preparation_progress_check1 CHECK ((route = ((get_byte(uuid_send(preparation_id), 10) * 256) + get_byte(uuid_send(preparation_id), 11)))),
    CONSTRAINT type_preparation_progress_check2 CHECK (((state <> 'ready'::text) OR ((type_id IS NOT NULL) AND (NOT enqueue_pending)))),
    CONSTRAINT type_preparation_progress_chunk_check CHECK ((chunk >= 0)),
    CONSTRAINT type_preparation_progress_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT type_preparation_progress_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text, 'cancelled'::text])))
);


--
-- Name: TABLE type_preparation_progress; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.type_preparation_progress IS 'Mutable native checkpoint/final mapping, separate from immutable evidence. Runner verifies offset <= header length, reservation/source association, current owner epoch, command and readiness. Edges/reservation progress, checkpoint and successor outbox commit together; final key, ready progress and reservation removal commit atomically. No cross-table CHECK or callback confers authority.';


--
-- Name: type_preparation_slot; Type: TABLE; Schema: library; Owner: -
--

CREATE TABLE library.type_preparation_slot (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    binding_digest text NOT NULL,
    preparation_id uuid NOT NULL,
    CONSTRAINT type_preparation_slot_binding_digest_check CHECK ((binding_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT type_preparation_slot_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT type_preparation_slot_check1 CHECK ((route = ((get_byte(uuid_send(preparation_id), 10) * 256) + get_byte(uuid_send(preparation_id), 11)))),
    CONSTRAINT type_preparation_slot_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE type_preparation_slot; Type: COMMENT; Schema: library; Owner: -
--

COMMENT ON TABLE library.type_preparation_slot IS 'Active owner binding slot. Digest hits require exact full binding, principal and native input comparison; collisions never alias. Equal live work converges. Only an admitted producer under current account/gate locks may replace cancelled/missing generations with a fresh UUID; source/owner epoch changes binding. Old receipts cannot trap replacement; purged owners cannot recreate slots. PKs support bounded owner enumeration: retirement/purge removes slots, progress, then headers/reservations and retains a minimal terminal fence. No automatic TTL or cascade.';


--
-- Name: bulk_effect bulk_effect_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.bulk_effect
    ADD CONSTRAINT bulk_effect_pkey PRIMARY KEY (route, operation_id, ordinal);


--
-- Name: bulk_target bulk_target_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.bulk_target
    ADD CONSTRAINT bulk_target_pkey PRIMARY KEY (route, operation_id, ordinal);


--
-- Name: collection_member collection_member_ordinal_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_member
    ADD CONSTRAINT collection_member_ordinal_key UNIQUE (route, collection_id, ordinal_key) DEFERRABLE;


--
-- Name: collection_member collection_member_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_member
    ADD CONSTRAINT collection_member_pkey PRIMARY KEY (route, collection_id, member_id);


--
-- Name: collection collection_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection
    ADD CONSTRAINT collection_pkey PRIMARY KEY (route, collection_id);


--
-- Name: copy copy_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.copy
    ADD CONSTRAINT copy_pkey PRIMARY KEY (route, copy_id);


--
-- Name: entry entry_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.entry
    ADD CONSTRAINT entry_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: follow follow_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.follow
    ADD CONSTRAINT follow_pkey PRIMARY KEY (route, account_id, target_id);


--
-- Name: progress_change progress_change_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_change
    ADD CONSTRAINT progress_change_pkey PRIMARY KEY (route, session_id, change_no);


--
-- Name: progress_head progress_head_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_head
    ADD CONSTRAINT progress_head_pkey PRIMARY KEY (route, account_id, subject_id);


--
-- Name: progress_session progress_session_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_session
    ADD CONSTRAINT progress_session_pkey PRIMARY KEY (route, session_id);


--
-- Name: progress_unit progress_unit_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_unit
    ADD CONSTRAINT progress_unit_pkey PRIMARY KEY (route, session_id, unit_id);


--
-- Name: published_log published_log_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.published_log
    ADD CONSTRAINT published_log_pkey PRIMARY KEY (route, log_id);


--
-- Name: shelf_count shelf_count_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_count
    ADD CONSTRAINT shelf_count_pkey PRIMARY KEY (route, account_id, bucket, type_id);


--
-- Name: shelf_type_node shelf_type_node_parent_chunk_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_node
    ADD CONSTRAINT shelf_type_node_parent_chunk_key UNIQUE (route, account_id, parent_id, chunk);


--
-- Name: shelf_type_node shelf_type_node_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_node
    ADD CONSTRAINT shelf_type_node_pkey PRIMARY KEY (route, account_id, node_id);


--
-- Name: shelf_type_reservation shelf_type_reservation_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_reservation
    ADD CONSTRAINT shelf_type_reservation_pkey PRIMARY KEY (route, account_id, reservation_id);


--
-- Name: shelf_type_root shelf_type_root_owner_node_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_root
    ADD CONSTRAINT shelf_type_root_owner_node_key UNIQUE (route, account_id, root_node_id);


--
-- Name: shelf_type_root shelf_type_root_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_root
    ADD CONSTRAINT shelf_type_root_pkey PRIMARY KEY (route, account_id, digest);


--
-- Name: shelf_type_value shelf_type_value_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_value
    ADD CONSTRAINT shelf_type_value_pkey PRIMARY KEY (route, account_id, type_id);


--
-- Name: subject_collection subject_collection_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.subject_collection
    ADD CONSTRAINT subject_collection_pkey PRIMARY KEY (route, subject_id, collection_id);


--
-- Name: subject_listing subject_listing_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.subject_listing
    ADD CONSTRAINT subject_listing_pkey PRIMARY KEY (route, subject_id);


--
-- Name: type_preparation_header type_preparation_header_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_header
    ADD CONSTRAINT type_preparation_header_pkey PRIMARY KEY (route, account_id, preparation_id);


--
-- Name: type_preparation_header type_preparation_header_route_account_id_binding_digest_pre_key; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_header
    ADD CONSTRAINT type_preparation_header_route_account_id_binding_digest_pre_key UNIQUE (route, account_id, binding_digest, preparation_id);


--
-- Name: type_preparation_progress type_preparation_progress_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_progress
    ADD CONSTRAINT type_preparation_progress_pkey PRIMARY KEY (route, account_id, preparation_id);


--
-- Name: type_preparation_slot type_preparation_slot_pkey; Type: CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_slot
    ADD CONSTRAINT type_preparation_slot_pkey PRIMARY KEY (route, account_id, binding_digest);


--
-- Name: bulk_effect_expiry; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_effect_expiry ON library.bulk_effect USING btree (route, expires_at, operation_id, ordinal);


--
-- Name: bulk_target_occurrence; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX bulk_target_occurrence ON library.bulk_target USING btree (route, operation_id, collection_id, member_id) WHERE (target_kind = 'occurrence'::text);


--
-- Name: bulk_target_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_target_pending ON library.bulk_target USING btree (route, operation_id, ordinal) WHERE (state = ANY (ARRAY['pending'::text, 'reconciling'::text]));


--
-- Name: bulk_target_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX bulk_target_state ON library.bulk_target USING btree (route, operation_id, state, ordinal);


--
-- Name: bulk_target_subject; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX bulk_target_subject ON library.bulk_target USING btree (route, operation_id, subject_id) WHERE (target_kind = 'subject'::text);


--
-- Name: collection_curator_listing; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_curator_listing ON library.collection USING btree (route, curator_account_id, collection_id);


--
-- Name: collection_curator_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_curator_page ON library.collection USING btree (route, curator_account_id, updated_at DESC, collection_id DESC) WHERE (state = 'active'::text);


--
-- Name: collection_curator_public_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_curator_public_page ON library.collection USING btree (route, curator_account_id, updated_at DESC, collection_id DESC) WHERE ((state = 'active'::text) AND (visibility = 'public'::text));


--
-- Name: collection_member_subject; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_member_subject ON library.collection_member USING btree (route, collection_id, subject_id);


--
-- Name: collection_sitemap_public_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX collection_sitemap_public_page ON library.collection USING btree (route, collection_id) INCLUDE (updated_at) WHERE ((state = 'active'::text) AND (visibility = 'public'::text));


--
-- Name: copy_account_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_account_created ON library.copy USING btree (route, account_id, created_at, copy_id);


--
-- Name: copy_account_subject_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX copy_account_subject_created ON library.copy USING btree (route, account_id, subject_id, created_at, copy_id);


--
-- Name: entry_account_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_account_state ON library.entry USING btree (route, account_id, state, updated_at DESC, subject_id);


--
-- Name: entry_account_updated; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_account_updated ON library.entry USING btree (route, account_id, updated_at DESC, subject_id);


--
-- Name: entry_shelf_activity; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity ON library.entry USING btree (route, account_id, activity_at DESC, subject_id);


--
-- Name: entry_shelf_activity_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity_state ON library.entry USING btree (route, account_id, state, activity_at DESC, subject_id);


--
-- Name: entry_shelf_activity_state_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity_state_type ON library.entry USING btree (route, account_id, state, type_id, activity_at DESC, subject_id);


--
-- Name: entry_shelf_activity_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_activity_type ON library.entry USING btree (route, account_id, type_id, activity_at DESC, subject_id);


--
-- Name: entry_shelf_created; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created ON library.entry USING btree (route, account_id, created_at DESC, subject_id);


--
-- Name: entry_shelf_created_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created_state ON library.entry USING btree (route, account_id, state, created_at DESC, subject_id);


--
-- Name: entry_shelf_created_state_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created_state_type ON library.entry USING btree (route, account_id, state, type_id, created_at DESC, subject_id);


--
-- Name: entry_shelf_created_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_created_type ON library.entry USING btree (route, account_id, type_id, created_at DESC, subject_id);


--
-- Name: entry_shelf_finished; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished ON library.entry USING btree (route, account_id, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_shelf_finished_state; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished_state ON library.entry USING btree (route, account_id, state, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_shelf_finished_state_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished_state_type ON library.entry USING btree (route, account_id, state, type_id, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_shelf_finished_type; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_shelf_finished_type ON library.entry USING btree (route, account_id, type_id, finished_at DESC NULLS LAST, subject_id);


--
-- Name: entry_type_source; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX entry_type_source ON library.entry USING btree (type_source_id, route, account_id, subject_id);


--
-- Name: follow_account_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX follow_account_page ON library.follow USING btree (route, account_id, state, updated_at DESC, target_id);


--
-- Name: progress_session_account_subject; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_account_subject ON library.progress_session USING btree (route, account_id, subject_id, started_at DESC, session_id);


--
-- Name: progress_session_active; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_active ON library.progress_session USING btree (route, account_id, subject_id, last_changed_at DESC, session_id) WHERE (state = 'active'::text);


--
-- Name: progress_session_owner_seek; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX progress_session_owner_seek ON library.progress_session USING btree (route, account_id, session_id);


--
-- Name: published_log_account_page; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX published_log_account_page ON library.published_log USING btree (route, account_id, published_at DESC, log_id);


--
-- Name: shelf_count_types; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX shelf_count_types ON library.shelf_count USING btree (route, account_id, type_id) WHERE ((bucket = 'all'::text) AND (type_id <> '00000000-0000-0000-0000-000000000000'::uuid) AND (n > 0));


--
-- Name: shelf_type_node_terminal_type; Type: INDEX; Schema: library; Owner: -
--

CREATE UNIQUE INDEX shelf_type_node_terminal_type ON library.shelf_type_node USING btree (route, account_id, terminal_type_id) WHERE (terminal_type_id IS NOT NULL);


--
-- Name: type_preparation_pending; Type: INDEX; Schema: library; Owner: -
--

CREATE INDEX type_preparation_pending ON library.type_preparation_progress USING btree (route, account_id, preparation_id) WHERE (enqueue_pending AND (state = 'pending'::text));


--
-- Name: follow follow_target_type_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER follow_target_type_immutable BEFORE UPDATE OF target_type ON library.follow FOR EACH ROW EXECUTE FUNCTION library.guard_follow_target_type();


--
-- Name: type_preparation_header type_preparation_header_immutable; Type: TRIGGER; Schema: library; Owner: -
--

CREATE TRIGGER type_preparation_header_immutable BEFORE UPDATE ON library.type_preparation_header FOR EACH ROW EXECUTE FUNCTION library.guard_type_preparation_header();


--
-- Name: collection_member collection_member_route_collection_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.collection_member
    ADD CONSTRAINT collection_member_route_collection_id_fkey FOREIGN KEY (route, collection_id) REFERENCES library.collection(route, collection_id);


--
-- Name: progress_change progress_change_route_session_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_change
    ADD CONSTRAINT progress_change_route_session_id_fkey FOREIGN KEY (route, session_id) REFERENCES library.progress_session(route, session_id);


--
-- Name: progress_unit progress_unit_route_session_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.progress_unit
    ADD CONSTRAINT progress_unit_route_session_id_fkey FOREIGN KEY (route, session_id) REFERENCES library.progress_session(route, session_id);


--
-- Name: shelf_type_node shelf_type_node_terminal_type_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_node
    ADD CONSTRAINT shelf_type_node_terminal_type_id_fkey FOREIGN KEY (route, account_id, terminal_type_id) REFERENCES library.shelf_type_value(route, account_id, type_id);


--
-- Name: shelf_type_root shelf_type_root_primary_type_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.shelf_type_root
    ADD CONSTRAINT shelf_type_root_primary_type_id_fkey FOREIGN KEY (route, account_id, primary_type_id) REFERENCES library.shelf_type_value(route, account_id, type_id);


--
-- Name: type_preparation_progress type_preparation_progress_route_account_id_preparation_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_progress
    ADD CONSTRAINT type_preparation_progress_route_account_id_preparation_id_fkey FOREIGN KEY (route, account_id, preparation_id) REFERENCES library.type_preparation_header(route, account_id, preparation_id);


--
-- Name: type_preparation_progress type_preparation_progress_route_account_id_type_id_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_progress
    ADD CONSTRAINT type_preparation_progress_route_account_id_type_id_fkey FOREIGN KEY (route, account_id, type_id) REFERENCES library.shelf_type_value(route, account_id, type_id);


--
-- Name: type_preparation_slot type_preparation_slot_route_account_id_binding_digest_prep_fkey; Type: FK CONSTRAINT; Schema: library; Owner: -
--

ALTER TABLE ONLY library.type_preparation_slot
    ADD CONSTRAINT type_preparation_slot_route_account_id_binding_digest_prep_fkey FOREIGN KEY (route, account_id, binding_digest, preparation_id) REFERENCES library.type_preparation_header(route, account_id, binding_digest, preparation_id);


--
-- PostgreSQL database dump complete
--


