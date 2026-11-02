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
-- Name: search; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA search;


--
-- Name: advance_public_filter_coverage_preparation(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.advance_public_filter_coverage_preparation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (NEW.partition_no,NEW.registration,NEW.bootstrap,NEW.definition,NEW.consumer,NEW.generation)
     IS DISTINCT FROM
     (OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.definition,OLD.consumer,OLD.generation)
  THEN
    RAISE EXCEPTION 'Original coverage preparation binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW IS DISTINCT FROM OLD AND
    (NEW.after_home <> OLD.after_home + 1 OR NOT EXISTS (
      SELECT 1 FROM search.public_filter_coverage_baseline b
      WHERE (b.partition_no,b.registration,b.bootstrap,b.source_home)=
        (OLD.partition_no,OLD.registration,OLD.bootstrap,OLD.after_home)
        AND b.predecessor=OLD.root AND b.root=NEW.root))
  THEN
    RAISE EXCEPTION 'Coverage preparation requires its original contiguous receipt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;


--
-- Name: enroll_retained_copy(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.enroll_retained_copy() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE target_name text;
BEGIN
  IF TG_TABLE_NAME='public_filter_registration' THEN
    target_name := NEW.physical_target;
  ELSE
    SELECT physical_target INTO target_name FROM search.public_filter_registration
      WHERE (partition_no,id)=(NEW.partition_no,NEW.registration);
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(target_name,741));
  IF EXISTS(SELECT 1 FROM search.identity_writer_gate
    WHERE partition_no=0 AND physical_target=target_name AND publication_fence IS NOT NULL) THEN
    RAISE EXCEPTION 'Search generation is fenced for native publication';
  END IF;
  IF TG_TABLE_NAME='public_filter_registration' THEN
    UPDATE search.public_filter_target SET copy_revision=copy_revision+1
      WHERE partition_no=NEW.partition_no AND physical_target=NEW.physical_target;
  ELSE
    UPDATE search.public_filter_target t SET copy_revision=t.copy_revision+1
      FROM search.public_filter_registration r
      WHERE (r.partition_no,r.id)=(NEW.partition_no,NEW.registration)
        AND (t.partition_no,t.physical_target)=(r.partition_no,r.physical_target);
  END IF;
  RETURN NEW;
END $$;


--
-- Name: retain_public_filter_coverage_baseline(); Type: FUNCTION; Schema: search; Owner: -
--

CREATE FUNCTION search.retain_public_filter_coverage_baseline() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Original coverage baseline is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: discovery_copy; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.discovery_copy (
    route integer NOT NULL,
    source_id uuid NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    kind text NOT NULL COLLATE pg_catalog."C",
    "position" bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    deleted boolean DEFAULT false NOT NULL,
    settled boolean DEFAULT false NOT NULL,
    CONSTRAINT discovery_copy_check CHECK ((route = ((get_byte(uuid_send(source_id), 10) * 256) + get_byte(uuid_send(source_id), 11)))),
    CONSTRAINT discovery_copy_position_check CHECK (("position" >= 0)),
    CONSTRAINT discovery_copy_revision_check CHECK ((revision >= 0)),
    CONSTRAINT discovery_copy_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: discovery_erasure; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.discovery_erasure (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    CONSTRAINT discovery_erasure_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11))))
);


--
-- Name: discovery_generation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.discovery_generation (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    index_uuid text COLLATE pg_catalog."C",
    incarnation uuid NOT NULL,
    kinds text[] NOT NULL,
    state text NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT discovery_generation_generation_check CHECK ((generation > 0)),
    CONSTRAINT discovery_generation_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT discovery_generation_state_check CHECK ((state = ANY (ARRAY['allocated'::text, 'populating'::text, 'replaying'::text, 'reconciling'::text, 'ready'::text, 'active'::text, 'retiring'::text, 'retired'::text, 'quarantined'::text])))
);


--
-- Name: discovery_population; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.discovery_population (
    partition_no integer NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    owner text NOT NULL,
    after_route integer,
    after_id uuid,
    complete boolean DEFAULT false NOT NULL,
    certified boolean DEFAULT false NOT NULL,
    indexed bigint DEFAULT 0 NOT NULL,
    census bigint DEFAULT 0 NOT NULL,
    reconcile_position bigint,
    "position" bigint DEFAULT 0 NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    claim_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT discovery_population_check CHECK (((after_route IS NULL) = (after_id IS NULL))),
    CONSTRAINT discovery_population_check1 CHECK (((after_route IS NULL) OR ((after_route / 16) = partition_no))),
    CONSTRAINT discovery_population_claim_revision_check CHECK ((claim_revision >= 0)),
    CONSTRAINT discovery_population_owner_check CHECK ((owner = ANY (ARRAY['accounts'::text, 'semantic'::text]))),
    CONSTRAINT discovery_population_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT discovery_population_position_check CHECK (("position" >= 0)),
    CONSTRAINT discovery_population_revision_check CHECK ((revision >= 0))
);


--
-- Name: erasure_effect; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.erasure_effect (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL COLLATE pg_catalog."C",
    job uuid DEFAULT gen_random_uuid() NOT NULL,
    source_basis text NOT NULL,
    consumer jsonb NOT NULL,
    barrier jsonb NOT NULL,
    native_revision text NOT NULL,
    record_key text,
    key_offset integer DEFAULT 0 NOT NULL,
    fence text,
    phase text DEFAULT 'repair'::text NOT NULL,
    CONSTRAINT erasure_effect_barrier_check CHECK ((octet_length((barrier)::text) <= 4096)),
    CONSTRAINT erasure_effect_consumer_check CHECK ((octet_length((consumer)::text) <= 8192)),
    CONSTRAINT erasure_effect_fence_check CHECK ((octet_length(fence) <= 4096)),
    CONSTRAINT erasure_effect_key_offset_check CHECK ((key_offset >= 0)),
    CONSTRAINT erasure_effect_phase_check CHECK ((phase = ANY (ARRAY['repair'::text, 'fence'::text, 'drain'::text, 'adopt'::text, 'compact'::text, 'settled'::text, 'released'::text]))),
    CONSTRAINT erasure_effect_record_key_check CHECK ((octet_length(record_key) <= 4096)),
    CONSTRAINT erasure_effect_source_basis_check CHECK ((octet_length(source_basis) <= 4096))
);


--
-- Name: erasure_progress; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.erasure_progress (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    version integer NOT NULL,
    at timestamp with time zone NOT NULL,
    protocol integer NOT NULL,
    phase text NOT NULL,
    pending_reason text,
    ever_applied boolean DEFAULT false NOT NULL,
    frontier text,
    source_complete boolean DEFAULT false NOT NULL,
    personal_complete boolean DEFAULT false NOT NULL,
    acked boolean DEFAULT false NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT erasure_progress_frontier_check CHECK ((octet_length(frontier) <= 2048)),
    CONSTRAINT erasure_progress_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT erasure_progress_phase_check CHECK ((phase = ANY (ARRAY['sealing'::text, 'source'::text, 'copies'::text, 'repair'::text, 'drain'::text, 'finalize'::text, 'done'::text]))),
    CONSTRAINT erasure_progress_protocol_check CHECK ((protocol = 1)),
    CONSTRAINT erasure_progress_version_check CHECK ((version = 1))
);


--
-- Name: erasure_target; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.erasure_target (
    partition_no integer NOT NULL,
    account_id uuid NOT NULL,
    copy_home integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL COLLATE pg_catalog."C",
    copy_revision bigint NOT NULL,
    registration_after text COLLATE pg_catalog."C",
    copies_complete boolean DEFAULT false NOT NULL,
    CONSTRAINT erasure_target_copy_home_check CHECK (((copy_home >= 0) AND (copy_home <= 4095)))
);


--
-- Name: facet_generation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.facet_generation (
    partition_no integer NOT NULL,
    definition text NOT NULL COLLATE pg_catalog."C",
    generation text NOT NULL COLLATE pg_catalog."C",
    property text NOT NULL,
    observation text NOT NULL,
    state text NOT NULL,
    phase text NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    lease_until bigint DEFAULT 0 NOT NULL,
    expires_at bigint NOT NULL,
    frontier text,
    population_complete boolean DEFAULT false NOT NULL,
    subject text,
    terminal text,
    subject_type text,
    security_revision text,
    projection jsonb,
    accumulator jsonb DEFAULT '[]'::jsonb NOT NULL,
    contribution_after text COLLATE pg_catalog."C",
    as_of text,
    CONSTRAINT facet_generation_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT facet_generation_phase_check CHECK ((phase = ANY (ARRAY['population'::text, 'projection'::text, 'contribute'::text, 'seal'::text]))),
    CONSTRAINT facet_generation_state_check CHECK ((state = ANY (ARRAY['building'::text, 'ready'::text, 'retired'::text])))
);


--
-- Name: facet_stage; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.facet_stage (
    partition_no integer NOT NULL,
    definition text NOT NULL COLLATE pg_catalog."C",
    generation text NOT NULL COLLATE pg_catalog."C",
    subject text NOT NULL COLLATE pg_catalog."C",
    key text NOT NULL COLLATE pg_catalog."C",
    value text NOT NULL COLLATE pg_catalog."C",
    labels jsonb NOT NULL,
    target_original text,
    target_terminal text
);


--
-- Name: facet_value; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.facet_value (
    partition_no integer NOT NULL,
    definition text NOT NULL COLLATE pg_catalog."C",
    generation text NOT NULL COLLATE pg_catalog."C",
    value text NOT NULL COLLATE pg_catalog."C",
    labels jsonb NOT NULL,
    contributor_original text NOT NULL,
    contributor_terminal text NOT NULL,
    target_original text,
    target_terminal text
);


--
-- Name: generation_publication; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.generation_publication (
    partition_no integer DEFAULT 0 NOT NULL,
    job uuid NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    consumer jsonb NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    family text NOT NULL,
    native_incarnation text NOT NULL,
    pass bigint DEFAULT 1 NOT NULL,
    activated_at text NOT NULL,
    kinds text[] NOT NULL,
    source_home integer NOT NULL,
    binding jsonb NOT NULL,
    phase text DEFAULT 'subject'::text NOT NULL,
    home integer DEFAULT 0 NOT NULL,
    after_route integer,
    after_id uuid,
    engine_after jsonb,
    pit text,
    fence text,
    fenced_pass boolean DEFAULT false NOT NULL,
    observation text,
    previous_target text,
    previous_uuid text,
    revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT generation_publication_binding_check CHECK ((octet_length((binding)::text) <= 8192)),
    CONSTRAINT generation_publication_check CHECK (((after_route IS NULL) = (after_id IS NULL))),
    CONSTRAINT generation_publication_consumer_check CHECK ((octet_length((consumer)::text) <= 8192)),
    CONSTRAINT generation_publication_engine_after_check CHECK ((octet_length((engine_after)::text) <= 8192)),
    CONSTRAINT generation_publication_family_check CHECK ((family = ANY (ARRAY['subjects'::text, 'discovery'::text]))),
    CONSTRAINT generation_publication_fence_check CHECK ((octet_length(fence) <= 8192)),
    CONSTRAINT generation_publication_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT generation_publication_home_check CHECK (((home >= 0) AND (home <= 4096))),
    CONSTRAINT generation_publication_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT generation_publication_pass_check CHECK ((pass > 0)),
    CONSTRAINT generation_publication_phase_check CHECK ((phase = ANY (ARRAY['subject'::text, 'account'::text, 'engine'::text, 'validate'::text, 'reconciled'::text, 'fencing'::text, 'intent'::text, 'active'::text]))),
    CONSTRAINT generation_publication_pit_check CHECK ((octet_length(pit) <= 65536)),
    CONSTRAINT generation_publication_revision_check CHECK ((revision > 0)),
    CONSTRAINT generation_publication_source_home_check CHECK (((source_home >= 0) AND (source_home <= 4095)))
);


--
-- Name: generation_publication_home; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.generation_publication_home (
    partition_no integer NOT NULL,
    job uuid NOT NULL,
    pass bigint NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    account_revision bigint DEFAULT 0 NOT NULL,
    claim_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT generation_publication_home_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT generation_publication_home_pass_check CHECK ((pass > 0)),
    CONSTRAINT generation_publication_home_position_check CHECK (("position" >= 0))
);


--
-- Name: identity_writer; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_writer (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    original_id uuid NOT NULL,
    incarnation text NOT NULL,
    owner_epoch integer NOT NULL,
    writer_token uuid,
    writer_transaction_id uuid,
    writer_position bigint,
    settled_transaction_id uuid,
    settled_position bigint,
    source_position bigint,
    closed_job uuid,
    closed_epoch bigint,
    closed_transaction_id uuid,
    closed_position bigint,
    dispatch_state text DEFAULT 'enrolled'::text NOT NULL,
    visible_transaction_id uuid,
    visible_position bigint,
    repair_locator text,
    repair_action text,
    repair_receipt text,
    repair_account text,
    CONSTRAINT identity_writer_check CHECK (((writer_transaction_id IS NULL) = (writer_position IS NULL))),
    CONSTRAINT identity_writer_check1 CHECK (((writer_token IS NULL) OR (writer_transaction_id IS NOT NULL))),
    CONSTRAINT identity_writer_check2 CHECK (((settled_transaction_id IS NULL) = (settled_position IS NULL))),
    CONSTRAINT identity_writer_check3 CHECK (((closed_job IS NULL) = (closed_epoch IS NULL))),
    CONSTRAINT identity_writer_check4 CHECK (((closed_job IS NULL) = (closed_transaction_id IS NULL))),
    CONSTRAINT identity_writer_check5 CHECK (((closed_job IS NULL) = (closed_position IS NULL))),
    CONSTRAINT identity_writer_check6 CHECK (((visible_transaction_id IS NULL) = (visible_position IS NULL))),
    CONSTRAINT identity_writer_closed_epoch_check CHECK ((closed_epoch > 0)),
    CONSTRAINT identity_writer_closed_position_check CHECK ((closed_position > 0)),
    CONSTRAINT identity_writer_dispatch_state_check CHECK ((dispatch_state = ANY (ARRAY['enrolled'::text, 'dispatched'::text, 'settled'::text, 'cancelled'::text]))),
    CONSTRAINT identity_writer_incarnation_check CHECK (((octet_length(incarnation) >= 1) AND (octet_length(incarnation) <= 128))),
    CONSTRAINT identity_writer_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT identity_writer_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_writer_physical_target_check CHECK (((octet_length(physical_target) >= 1) AND (octet_length(physical_target) <= 255))),
    CONSTRAINT identity_writer_repair_account_check CHECK ((octet_length(repair_account) <= 65536)),
    CONSTRAINT identity_writer_repair_action_check CHECK ((octet_length(repair_action) <= 1048576)),
    CONSTRAINT identity_writer_repair_locator_check CHECK ((octet_length(repair_locator) <= 8192)),
    CONSTRAINT identity_writer_repair_receipt_check CHECK ((octet_length(repair_receipt) <= 1048576)),
    CONSTRAINT identity_writer_settled_position_check CHECK ((settled_position > 0)),
    CONSTRAINT identity_writer_source_position_check CHECK ((source_position >= 0)),
    CONSTRAINT identity_writer_visible_position_check CHECK ((visible_position > 0)),
    CONSTRAINT identity_writer_writer_position_check CHECK ((writer_position > 0))
);


--
-- Name: identity_writer_gate; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.identity_writer_gate (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    consumer text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL,
    write_alias text NOT NULL,
    owner_epoch integer NOT NULL,
    enrollment_generation bigint DEFAULT 0 NOT NULL,
    fence_generation bigint DEFAULT 0 NOT NULL,
    closed_token uuid,
    closed_transaction_id uuid,
    closed_position bigint,
    publication_job uuid,
    publication_consumer jsonb,
    publication_fence uuid,
    publication_released_fence uuid,
    publication_home integer DEFAULT 0 NOT NULL,
    publication_after uuid,
    publication_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT identity_writer_gate_check CHECK (((closed_token IS NULL) = (closed_transaction_id IS NULL))),
    CONSTRAINT identity_writer_gate_check1 CHECK (((closed_token IS NULL) = (closed_position IS NULL))),
    CONSTRAINT identity_writer_gate_check2 CHECK (((closed_token IS NULL) = (fence_generation = 0))),
    CONSTRAINT identity_writer_gate_check3 CHECK (((publication_fence IS NULL) OR ((publication_job IS NOT NULL) AND (publication_consumer IS NOT NULL)))),
    CONSTRAINT identity_writer_gate_check4 CHECK (((partition_no = 0) OR (publication_job IS NULL))),
    CONSTRAINT identity_writer_gate_closed_position_check CHECK ((closed_position > 0)),
    CONSTRAINT identity_writer_gate_consumer_check CHECK ((consumer ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT identity_writer_gate_enrollment_generation_check CHECK ((enrollment_generation >= 0)),
    CONSTRAINT identity_writer_gate_fence_generation_check CHECK ((fence_generation >= 0)),
    CONSTRAINT identity_writer_gate_incarnation_check CHECK (((octet_length(incarnation) >= 1) AND (octet_length(incarnation) <= 128))),
    CONSTRAINT identity_writer_gate_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT identity_writer_gate_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_writer_gate_physical_target_check CHECK (((octet_length(physical_target) >= 1) AND (octet_length(physical_target) <= 255))),
    CONSTRAINT identity_writer_gate_publication_consumer_check CHECK ((octet_length((publication_consumer)::text) <= 8192)),
    CONSTRAINT identity_writer_gate_publication_home_check CHECK (((publication_home >= 0) AND (publication_home <= 4096))),
    CONSTRAINT identity_writer_gate_publication_revision_check CHECK ((publication_revision >= 0)),
    CONSTRAINT identity_writer_gate_write_alias_check CHECK (((octet_length(write_alias) >= 1) AND (octet_length(write_alias) <= 255)))
);


--
-- Name: index_home_coverage; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.index_home_coverage (
    partition_no integer NOT NULL,
    consumer text NOT NULL COLLATE pg_catalog."C",
    index_uuid text NOT NULL COLLATE pg_catalog."C",
    revision bigint NOT NULL,
    current jsonb,
    fence jsonb,
    verified jsonb,
    covered_through jsonb,
    attempt jsonb,
    CONSTRAINT index_home_coverage_attempt_check CHECK (((jsonb_typeof(attempt) = 'object'::text) AND (octet_length((attempt)::text) <= 4096))),
    CONSTRAINT index_home_coverage_check CHECK (((current IS NULL) = (fence IS NULL))),
    CONSTRAINT index_home_coverage_check1 CHECK (((verified IS NULL) = (covered_through IS NULL))),
    CONSTRAINT index_home_coverage_consumer_check CHECK (((octet_length(consumer) >= 1) AND (octet_length(consumer) <= 63))),
    CONSTRAINT index_home_coverage_covered_through_check CHECK (((jsonb_typeof(covered_through) = 'object'::text) AND (octet_length((covered_through)::text) <= 256))),
    CONSTRAINT index_home_coverage_current_check CHECK (((jsonb_typeof(current) = 'object'::text) AND (octet_length((current)::text) <= 2048))),
    CONSTRAINT index_home_coverage_fence_check CHECK (((jsonb_typeof(fence) = 'object'::text) AND (octet_length((fence)::text) <= 512))),
    CONSTRAINT index_home_coverage_index_uuid_check CHECK (((octet_length(index_uuid) >= 1) AND (octet_length(index_uuid) <= 128))),
    CONSTRAINT index_home_coverage_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT index_home_coverage_revision_check CHECK ((revision > 0)),
    CONSTRAINT index_home_coverage_verified_check CHECK (((jsonb_typeof(verified) = 'object'::text) AND (octet_length((verified)::text) <= 2048)))
);


--
-- Name: index_incarnation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.index_incarnation (
    partition_no integer DEFAULT 0 NOT NULL,
    consumer text NOT NULL COLLATE pg_catalog."C",
    index_uuid text NOT NULL COLLATE pg_catalog."C",
    prefix text NOT NULL COLLATE pg_catalog."C",
    generation bigint NOT NULL,
    index_name text NOT NULL COLLATE pg_catalog."C",
    protocol text NOT NULL,
    revision bigint NOT NULL,
    state text NOT NULL,
    origin text NOT NULL,
    population_partition integer NOT NULL,
    population_after uuid,
    population_complete boolean NOT NULL,
    CONSTRAINT index_incarnation_check CHECK (((population_complete AND (population_partition = 4096) AND (population_after IS NULL)) OR ((NOT population_complete) AND (population_partition < 4096)))),
    CONSTRAINT index_incarnation_check1 CHECK (((state <> 'live'::text) OR population_complete)),
    CONSTRAINT index_incarnation_consumer_check CHECK (((octet_length(consumer) >= 1) AND (octet_length(consumer) <= 63))),
    CONSTRAINT index_incarnation_generation_check CHECK (((generation >= 1) AND (generation <= '9007199254740991'::bigint))),
    CONSTRAINT index_incarnation_index_name_check CHECK (((octet_length(index_name) >= 1) AND (octet_length(index_name) <= 255))),
    CONSTRAINT index_incarnation_index_uuid_check CHECK (((octet_length(index_uuid) >= 1) AND (octet_length(index_uuid) <= 128))),
    CONSTRAINT index_incarnation_origin_check CHECK ((origin = ANY (ARRAY['created-empty'::text, 'replay'::text, 'audit'::text]))),
    CONSTRAINT index_incarnation_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT index_incarnation_population_partition_check CHECK (((population_partition >= 0) AND (population_partition <= 4096))),
    CONSTRAINT index_incarnation_protocol_check CHECK ((protocol = 'subject-coverage-v1'::text)),
    CONSTRAINT index_incarnation_revision_check CHECK ((revision > 0)),
    CONSTRAINT index_incarnation_state_check CHECK ((state = ANY (ARRAY['populating'::text, 'live'::text, 'quarantined'::text, 'retiring'::text])))
);


--
-- Name: index_prefix_control; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.index_prefix_control (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    revision bigint NOT NULL,
    issued_generation bigint NOT NULL,
    allocation_bound boolean DEFAULT false NOT NULL,
    CONSTRAINT index_prefix_control_issued_generation_check CHECK (((issued_generation >= 1) AND (issued_generation <= '9007199254740991'::bigint))),
    CONSTRAINT index_prefix_control_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT index_prefix_control_prefix_check CHECK ((prefix ~ '^[a-z0-9][a-z0-9-]{0,47}$'::text)),
    CONSTRAINT index_prefix_control_revision_check CHECK ((revision > 0))
);


--
-- Name: public_filter_coverage_baseline; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_coverage_baseline (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    source_home integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    creation_position bigint NOT NULL,
    native_enqueue_revision bigint CONSTRAINT public_filter_coverage_baselin_native_enqueue_revision_not_null NOT NULL,
    native_revision bigint,
    native_claim_revision bigint,
    receipt text NOT NULL,
    predecessor text NOT NULL,
    root text NOT NULL,
    CONSTRAINT public_filter_coverage_baseline_check CHECK (((native_revision IS NULL) = (native_claim_revision IS NULL))),
    CONSTRAINT public_filter_coverage_baseline_check1 CHECK (((native_revision IS NULL) OR ((native_revision > 0) AND (native_claim_revision > 0)))),
    CONSTRAINT public_filter_coverage_baseline_creation_position_check CHECK ((creation_position >= 0)),
    CONSTRAINT public_filter_coverage_baseline_native_enqueue_revision_check CHECK ((native_enqueue_revision >= 0)),
    CONSTRAINT public_filter_coverage_baseline_predecessor_check CHECK ((predecessor ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_coverage_baseline_receipt_check CHECK ((receipt ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_coverage_baseline_root_check CHECK ((root ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT public_filter_coverage_baseline_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT public_filter_coverage_baseline_source_home_check CHECK (((source_home >= 0) AND (source_home <= 4095))),
    CONSTRAINT public_filter_coverage_baseline_source_position_check CHECK ((source_position >= 0))
);


--
-- Name: public_filter_coverage_home; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_coverage_home (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    source_home integer NOT NULL,
    source_epoch integer NOT NULL,
    relevant_position bigint NOT NULL,
    acknowledged_position bigint DEFAULT 0 NOT NULL,
    native_enqueue_revision bigint DEFAULT 0 NOT NULL,
    native_revision bigint,
    native_claim_revision bigint,
    acknowledged_native_revision bigint,
    acknowledged_native_claim_revision bigint,
    last_change_generation bigint NOT NULL,
    behind boolean DEFAULT true NOT NULL,
    acknowledged_native_enqueue bigint DEFAULT 0 CONSTRAINT public_filter_coverage_home_acknowledged_native_enqueu_not_null NOT NULL,
    baseline_bootstrap uuid,
    acknowledged_baseline uuid,
    acknowledged_observation text,
    acknowledged_execution text,
    acknowledged_settlement text,
    CONSTRAINT public_filter_coverage_ack_receipt CHECK ((((acknowledged_observation IS NULL) = (acknowledged_execution IS NULL)) AND ((acknowledged_execution IS NULL) = (acknowledged_settlement IS NULL)) AND ((acknowledged_settlement IS NULL) OR (acknowledged_baseline IS NOT NULL)))),
    CONSTRAINT public_filter_coverage_home_ack_prefix CHECK ((behind OR ((baseline_bootstrap IS NOT NULL) AND (acknowledged_baseline IS NOT NULL) AND (acknowledged_baseline = baseline_bootstrap) AND (acknowledged_position >= relevant_position) AND (acknowledged_native_enqueue >= native_enqueue_revision) AND ((native_revision IS NULL) OR ((acknowledged_native_revision IS NOT NULL) AND (acknowledged_native_revision >= native_revision))) AND ((native_claim_revision IS NULL) OR ((acknowledged_native_claim_revision IS NOT NULL) AND (acknowledged_native_claim_revision >= native_claim_revision)))))),
    CONSTRAINT public_filter_coverage_home_acknowledged_execution_check CHECK (((octet_length(acknowledged_execution) >= 1) AND (octet_length(acknowledged_execution) <= 4096))),
    CONSTRAINT public_filter_coverage_home_acknowledged_native_enqueue_check CHECK ((acknowledged_native_enqueue >= 0)),
    CONSTRAINT public_filter_coverage_home_acknowledged_observation_check CHECK (((octet_length(acknowledged_observation) >= 1) AND (octet_length(acknowledged_observation) <= 4096))),
    CONSTRAINT public_filter_coverage_home_acknowledged_position_check CHECK ((acknowledged_position >= 0)),
    CONSTRAINT public_filter_coverage_home_acknowledged_settlement_check CHECK (((octet_length(acknowledged_settlement) >= 1) AND (octet_length(acknowledged_settlement) <= 4096))),
    CONSTRAINT public_filter_coverage_home_last_change_generation_check CHECK ((last_change_generation >= 0)),
    CONSTRAINT public_filter_coverage_home_native_enqueue_revision_check CHECK ((native_enqueue_revision >= 0)),
    CONSTRAINT public_filter_coverage_home_relevant_position_check CHECK ((relevant_position >= 0)),
    CONSTRAINT public_filter_coverage_home_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT public_filter_coverage_home_source_home_check CHECK (((source_home >= 0) AND (source_home <= 4095)))
);


--
-- Name: public_filter_coverage_preparation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_coverage_preparation (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    bootstrap uuid NOT NULL,
    definition uuid NOT NULL,
    consumer text NOT NULL,
    generation bigint NOT NULL,
    after_home integer DEFAULT 0 NOT NULL,
    root text NOT NULL,
    CONSTRAINT public_filter_coverage_preparation_after_home_check CHECK (((after_home >= 0) AND (after_home <= 4096))),
    CONSTRAINT public_filter_coverage_preparation_generation_check CHECK ((generation >= 0)),
    CONSTRAINT public_filter_coverage_preparation_root_check CHECK ((root ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: public_filter_execution; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_execution (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    id text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL,
    consumer_repair text,
    consumer_window text,
    repair_settlement text,
    CONSTRAINT public_filter_execution_consumer_repair_check CHECK ((octet_length(consumer_repair) <= 1048576)),
    CONSTRAINT public_filter_execution_consumer_window_check CHECK ((octet_length(consumer_window) <= 1048576)),
    CONSTRAINT public_filter_execution_execution_check CHECK ((octet_length(execution) <= 1048576)),
    CONSTRAINT public_filter_execution_repair_settlement_check CHECK ((octet_length(repair_settlement) <= 16384))
);


--
-- Name: public_filter_observation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_observation (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    registration text NOT NULL COLLATE pg_catalog."C",
    queried text NOT NULL,
    covered text NOT NULL,
    expires_at bigint NOT NULL,
    state text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    prepared_rows text,
    consumer_work text,
    consumer_bootstrap text,
    CONSTRAINT public_filter_observation_consumer_work_check CHECK ((octet_length(consumer_work) <= 1048576)),
    CONSTRAINT public_filter_observation_covered_check CHECK ((octet_length(covered) <= 4096)),
    CONSTRAINT public_filter_observation_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT public_filter_observation_prepared_rows_check CHECK ((octet_length(prepared_rows) <= 1048576)),
    CONSTRAINT public_filter_observation_queried_check CHECK ((octet_length(queried) <= 65536)),
    CONSTRAINT public_filter_observation_revision_check CHECK ((revision > 0)),
    CONSTRAINT public_filter_observation_state_check CHECK ((state = ANY (ARRAY['open'::text, 'closing'::text, 'closed'::text])))
);


--
-- Name: public_filter_pit; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_pit (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    id text NOT NULL COLLATE pg_catalog."C",
    locator text NOT NULL,
    state text NOT NULL,
    CONSTRAINT public_filter_pit_locator_check CHECK ((octet_length(locator) <= 65536)),
    CONSTRAINT public_filter_pit_state_check CHECK ((state = ANY (ARRAY['owned'::text, 'released'::text])))
);


--
-- Name: public_filter_prepared; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_prepared (
    partition_no integer NOT NULL,
    registration text NOT NULL COLLATE pg_catalog."C",
    build text NOT NULL COLLATE pg_catalog."C",
    generation numeric NOT NULL,
    rows text NOT NULL,
    state text DEFAULT 'active'::text NOT NULL,
    CONSTRAINT public_filter_prepared_generation_check CHECK (((generation > (0)::numeric) AND (scale(generation) = 0))),
    CONSTRAINT public_filter_prepared_rows_check CHECK ((octet_length(rows) <= 1048576)),
    CONSTRAINT public_filter_prepared_state_check CHECK ((state = ANY (ARRAY['active'::text, 'erasing'::text])))
);


--
-- Name: public_filter_reference; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_reference (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    token uuid NOT NULL,
    expires_at bigint NOT NULL
);


--
-- Name: public_filter_registration; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_registration (
    partition_no integer NOT NULL,
    id text NOT NULL COLLATE pg_catalog."C",
    physical_target text NOT NULL COLLATE pg_catalog."C",
    consumer text NOT NULL,
    definition text NOT NULL,
    state text NOT NULL,
    consumer_work text,
    consumer_bootstrap text,
    coverage_generation bigint DEFAULT 0 NOT NULL,
    CONSTRAINT public_filter_registration_consumer_check CHECK ((octet_length(consumer) <= 8192)),
    CONSTRAINT public_filter_registration_consumer_work_check CHECK ((octet_length(consumer_work) <= 1048576)),
    CONSTRAINT public_filter_registration_coverage_generation_check CHECK ((coverage_generation >= 0)),
    CONSTRAINT public_filter_registration_definition_check CHECK ((octet_length(definition) <= 1048576)),
    CONSTRAINT public_filter_registration_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT public_filter_registration_state_check CHECK ((state = ANY (ARRAY['active'::text, 'retired'::text])))
);


--
-- Name: public_filter_repair_effect; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_repair_effect (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL COLLATE pg_catalog."C",
    page integer NOT NULL,
    item integer NOT NULL,
    receipt text NOT NULL,
    CONSTRAINT public_filter_repair_effect_item_check CHECK ((item >= 0)),
    CONSTRAINT public_filter_repair_effect_receipt_check CHECK ((octet_length(receipt) <= 1048576))
);


--
-- Name: public_filter_repair_page; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_repair_page (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL COLLATE pg_catalog."C",
    ordinal integer NOT NULL,
    has_repairs boolean NOT NULL,
    intent text NOT NULL,
    CONSTRAINT public_filter_repair_page_intent_check CHECK ((octet_length(intent) <= 1048576)),
    CONSTRAINT public_filter_repair_page_ordinal_check CHECK ((ordinal >= 0))
);


--
-- Name: public_filter_target; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_target (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL,
    copy_revision bigint DEFAULT 1 NOT NULL,
    CONSTRAINT public_filter_target_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
);


--
-- Name: public_preparation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_preparation (
    partition_no integer NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    id uuid NOT NULL,
    kind text NOT NULL,
    locator jsonb NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    due_at bigint NOT NULL,
    lease_until bigint DEFAULT 0 NOT NULL,
    expires_at bigint NOT NULL,
    CONSTRAINT public_preparation_kind_check CHECK ((kind = ANY (ARRAY['population'::text, 'repair'::text]))),
    CONSTRAINT public_preparation_locator_check CHECK ((octet_length((locator)::text) <= 131072)),
    CONSTRAINT public_preparation_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT public_preparation_revision_check CHECK ((revision > 0))
);


--
-- Name: recent_search; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.recent_search (
    partition_no integer NOT NULL,
    route integer NOT NULL,
    account_id uuid NOT NULL,
    id uuid NOT NULL,
    entry jsonb NOT NULL,
    entry_key text NOT NULL,
    last_used timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT recent_search_check CHECK ((partition_no = (route >> 4))),
    CONSTRAINT recent_search_entry_check CHECK ((octet_length((entry)::text) <= 4096)),
    CONSTRAINT recent_search_revision_check CHECK ((revision > 0))
);


--
-- Name: recent_search_state; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.recent_search_state (
    partition_no integer NOT NULL,
    route integer NOT NULL,
    account_id uuid NOT NULL,
    revision integer DEFAULT 0 NOT NULL,
    CONSTRAINT recent_search_state_check CHECK ((partition_no = (route >> 4))),
    CONSTRAINT recent_search_state_revision_check CHECK ((revision >= 0))
);


--
-- Name: scope_preparation; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.scope_preparation (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    scope_id text NOT NULL COLLATE pg_catalog."C",
    definition jsonb NOT NULL,
    frontier jsonb NOT NULL,
    observation jsonb,
    ordinal_membership_progress jsonb,
    leaf_progress jsonb,
    ordinal_frontier jsonb,
    ordinal_complete boolean DEFAULT false NOT NULL,
    state text DEFAULT 'capture'::text NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    lease_until bigint DEFAULT 0 NOT NULL,
    due_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    ordered_state jsonb,
    CONSTRAINT scope_preparation_definition_check CHECK ((octet_length((definition)::text) <= 262144)),
    CONSTRAINT scope_preparation_frontier_check CHECK ((octet_length((frontier)::text) <= 8192)),
    CONSTRAINT scope_preparation_leaf_progress_check CHECK ((octet_length((leaf_progress)::text) <= 4096)),
    CONSTRAINT scope_preparation_observation_check CHECK ((octet_length((observation)::text) <= 8192)),
    CONSTRAINT scope_preparation_ordered_state_check CHECK ((octet_length((ordered_state)::text) <= 32768)),
    CONSTRAINT scope_preparation_ordinal_frontier_check CHECK ((octet_length((ordinal_frontier)::text) <= 1024)),
    CONSTRAINT scope_preparation_ordinal_membership_progress_check CHECK ((octet_length((ordinal_membership_progress)::text) <= 8192)),
    CONSTRAINT scope_preparation_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT scope_preparation_revision_check CHECK ((revision > 0)),
    CONSTRAINT scope_preparation_scope_id_check CHECK ((scope_id ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT scope_preparation_state_check CHECK ((state = ANY (ARRAY['capture'::text, 'ready'::text, 'retained'::text])))
);


--
-- Name: scope_preparation_ordered; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.scope_preparation_ordered (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    scope_id text NOT NULL COLLATE pg_catalog."C",
    subject uuid NOT NULL,
    count_key integer NOT NULL,
    name_key bytea NOT NULL,
    hit bytea NOT NULL,
    CONSTRAINT scope_preparation_ordered_count_key_check CHECK (((count_key >= '-2147483647'::integer) AND (count_key <= 0))),
    CONSTRAINT scope_preparation_ordered_hit_check CHECK ((octet_length(hit) <= 16384)),
    CONSTRAINT scope_preparation_ordered_name_key_check CHECK (((octet_length(name_key) >= 1) AND (octet_length(name_key) <= 1537))),
    CONSTRAINT scope_preparation_ordered_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: scope_preparation_ordinal; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.scope_preparation_ordinal (
    partition_no integer DEFAULT 0 NOT NULL,
    prefix text NOT NULL COLLATE pg_catalog."C",
    scope_id text NOT NULL COLLATE pg_catalog."C",
    cut text NOT NULL COLLATE pg_catalog."C",
    subject uuid NOT NULL,
    ordinal_key text NOT NULL COLLATE pg_catalog."C",
    member_id uuid NOT NULL,
    CONSTRAINT scope_preparation_ordinal_cut_check CHECK ((cut ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT scope_preparation_ordinal_ordinal_key_check CHECK ((octet_length(ordinal_key) <= 256)),
    CONSTRAINT scope_preparation_ordinal_partition_no_check CHECK ((partition_no = 0))
);


--
-- Name: trending_blocked; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.trending_blocked (
    route integer NOT NULL,
    kind text NOT NULL,
    identity uuid NOT NULL,
    CONSTRAINT trending_blocked_kind_check CHECK ((kind = ANY (ARRAY['account'::text, 'source'::text]))),
    CONSTRAINT trending_blocked_route_check CHECK ((route = 0))
);


--
-- Name: trending_member; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.trending_member (
    route integer NOT NULL,
    term_key text NOT NULL COLLATE pg_catalog."C",
    account_id uuid NOT NULL,
    day date NOT NULL,
    contributed_at timestamp with time zone NOT NULL,
    CONSTRAINT trending_member_route_check CHECK ((route = 0))
);


--
-- Name: trending_term; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.trending_term (
    route integer NOT NULL,
    term_key text NOT NULL COLLATE pg_catalog."C",
    language text NOT NULL,
    source_id uuid NOT NULL,
    display text NOT NULL,
    rank integer NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT trending_term_display_check CHECK (((octet_length(display) >= 1) AND (octet_length(display) <= 256))),
    CONSTRAINT trending_term_language_check CHECK ((octet_length(language) <= 35)),
    CONSTRAINT trending_term_rank_check CHECK (((rank >= 0) AND (rank <= 16))),
    CONSTRAINT trending_term_route_check CHECK ((route = 0)),
    CONSTRAINT trending_term_term_key_check CHECK ((term_key ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: discovery_copy discovery_copy_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.discovery_copy
    ADD CONSTRAINT discovery_copy_pkey PRIMARY KEY (route, source_id, prefix, generation, kind);


--
-- Name: discovery_erasure discovery_erasure_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.discovery_erasure
    ADD CONSTRAINT discovery_erasure_pkey PRIMARY KEY (route, account_id);


--
-- Name: discovery_generation discovery_generation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.discovery_generation
    ADD CONSTRAINT discovery_generation_pkey PRIMARY KEY (partition_no, prefix, generation);


--
-- Name: discovery_population discovery_population_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.discovery_population
    ADD CONSTRAINT discovery_population_pkey PRIMARY KEY (partition_no, prefix, generation, owner);


--
-- Name: erasure_effect erasure_effect_job_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.erasure_effect
    ADD CONSTRAINT erasure_effect_job_key UNIQUE (job);


--
-- Name: erasure_effect erasure_effect_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.erasure_effect
    ADD CONSTRAINT erasure_effect_pkey PRIMARY KEY (partition_no, account_id, physical_target, incarnation);


--
-- Name: erasure_progress erasure_progress_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.erasure_progress
    ADD CONSTRAINT erasure_progress_pkey PRIMARY KEY (partition_no, account_id);


--
-- Name: erasure_target erasure_target_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.erasure_target
    ADD CONSTRAINT erasure_target_pkey PRIMARY KEY (partition_no, account_id, copy_home, physical_target, incarnation);


--
-- Name: facet_generation facet_generation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_generation
    ADD CONSTRAINT facet_generation_pkey PRIMARY KEY (partition_no, definition, generation);


--
-- Name: facet_stage facet_stage_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_stage
    ADD CONSTRAINT facet_stage_pkey PRIMARY KEY (partition_no, definition, generation, subject, key);


--
-- Name: facet_value facet_value_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_value
    ADD CONSTRAINT facet_value_pkey PRIMARY KEY (partition_no, definition, generation, value);


--
-- Name: generation_publication_home generation_publication_home_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.generation_publication_home
    ADD CONSTRAINT generation_publication_home_pkey PRIMARY KEY (partition_no, job);


--
-- Name: generation_publication generation_publication_partition_no_physical_target_consume_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.generation_publication
    ADD CONSTRAINT generation_publication_partition_no_physical_target_consume_key UNIQUE (partition_no, physical_target, consumer);


--
-- Name: generation_publication generation_publication_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.generation_publication
    ADD CONSTRAINT generation_publication_pkey PRIMARY KEY (partition_no, job);


--
-- Name: identity_writer_gate identity_writer_gate_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_writer_gate
    ADD CONSTRAINT identity_writer_gate_pkey PRIMARY KEY (partition_no, physical_target);


--
-- Name: identity_writer identity_writer_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_writer
    ADD CONSTRAINT identity_writer_pkey PRIMARY KEY (partition_no, physical_target, original_id);


--
-- Name: index_home_coverage index_home_coverage_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_home_coverage
    ADD CONSTRAINT index_home_coverage_pkey PRIMARY KEY (partition_no, consumer, index_uuid);


--
-- Name: index_incarnation index_incarnation_partition_no_prefix_generation_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_incarnation
    ADD CONSTRAINT index_incarnation_partition_no_prefix_generation_key UNIQUE (partition_no, prefix, generation);


--
-- Name: index_incarnation index_incarnation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_incarnation
    ADD CONSTRAINT index_incarnation_pkey PRIMARY KEY (partition_no, consumer, index_uuid);


--
-- Name: index_prefix_control index_prefix_control_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_prefix_control
    ADD CONSTRAINT index_prefix_control_pkey PRIMARY KEY (partition_no, prefix);


--
-- Name: public_filter_coverage_baseline public_filter_coverage_baseline_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_baseline
    ADD CONSTRAINT public_filter_coverage_baseline_pkey PRIMARY KEY (partition_no, registration, bootstrap, source_home);


--
-- Name: public_filter_coverage_home public_filter_coverage_home_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_home
    ADD CONSTRAINT public_filter_coverage_home_pkey PRIMARY KEY (partition_no, registration, source_home);


--
-- Name: public_filter_coverage_preparation public_filter_coverage_preparation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_preparation
    ADD CONSTRAINT public_filter_coverage_preparation_pkey PRIMARY KEY (partition_no, registration, bootstrap);


--
-- Name: public_filter_execution public_filter_execution_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_execution
    ADD CONSTRAINT public_filter_execution_pkey PRIMARY KEY (partition_no, observation, id);


--
-- Name: public_filter_observation public_filter_observation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_observation
    ADD CONSTRAINT public_filter_observation_pkey PRIMARY KEY (partition_no, observation);


--
-- Name: public_filter_pit public_filter_pit_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_pit
    ADD CONSTRAINT public_filter_pit_pkey PRIMARY KEY (partition_no, observation, id);


--
-- Name: public_filter_prepared public_filter_prepared_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_prepared
    ADD CONSTRAINT public_filter_prepared_pkey PRIMARY KEY (partition_no, registration, build, generation);


--
-- Name: public_filter_reference public_filter_reference_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_reference
    ADD CONSTRAINT public_filter_reference_pkey PRIMARY KEY (partition_no, observation, token);


--
-- Name: public_filter_registration public_filter_registration_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_registration
    ADD CONSTRAINT public_filter_registration_pkey PRIMARY KEY (partition_no, id);


--
-- Name: public_filter_repair_effect public_filter_repair_effect_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_effect
    ADD CONSTRAINT public_filter_repair_effect_pkey PRIMARY KEY (partition_no, observation, execution, page, item);


--
-- Name: public_filter_repair_page public_filter_repair_page_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_page
    ADD CONSTRAINT public_filter_repair_page_pkey PRIMARY KEY (partition_no, observation, execution, ordinal);


--
-- Name: public_filter_target public_filter_target_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_target
    ADD CONSTRAINT public_filter_target_pkey PRIMARY KEY (partition_no, physical_target);


--
-- Name: public_preparation public_preparation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_preparation
    ADD CONSTRAINT public_preparation_pkey PRIMARY KEY (partition_no, id);


--
-- Name: recent_search recent_search_partition_no_route_account_id_entry_key_key; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.recent_search
    ADD CONSTRAINT recent_search_partition_no_route_account_id_entry_key_key UNIQUE (partition_no, route, account_id, entry_key);


--
-- Name: recent_search recent_search_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.recent_search
    ADD CONSTRAINT recent_search_pkey PRIMARY KEY (partition_no, route, account_id, id);


--
-- Name: recent_search_state recent_search_state_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.recent_search_state
    ADD CONSTRAINT recent_search_state_pkey PRIMARY KEY (partition_no, route, account_id);


--
-- Name: scope_preparation_ordered scope_preparation_ordered_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.scope_preparation_ordered
    ADD CONSTRAINT scope_preparation_ordered_pkey PRIMARY KEY (partition_no, prefix, scope_id, subject);


--
-- Name: scope_preparation_ordinal scope_preparation_ordinal_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.scope_preparation_ordinal
    ADD CONSTRAINT scope_preparation_ordinal_pkey PRIMARY KEY (partition_no, prefix, scope_id, cut, subject);


--
-- Name: scope_preparation scope_preparation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.scope_preparation
    ADD CONSTRAINT scope_preparation_pkey PRIMARY KEY (partition_no, prefix, scope_id);


--
-- Name: trending_blocked trending_blocked_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.trending_blocked
    ADD CONSTRAINT trending_blocked_pkey PRIMARY KEY (route, kind, identity);


--
-- Name: trending_member trending_member_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.trending_member
    ADD CONSTRAINT trending_member_pkey PRIMARY KEY (route, term_key, account_id);


--
-- Name: trending_term trending_term_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.trending_term
    ADD CONSTRAINT trending_term_pkey PRIMARY KEY (route, term_key);


--
-- Name: discovery_copy_generation; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX discovery_copy_generation ON search.discovery_copy USING btree (prefix, generation, route, source_id, kind);


--
-- Name: discovery_population_pending; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX discovery_population_pending ON search.discovery_population USING btree (prefix, generation, partition_no, owner) WHERE (NOT complete);


--
-- Name: facet_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX facet_expiry ON search.facet_generation USING btree (expires_at, partition_no, definition, generation);


--
-- Name: facet_one_building; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX facet_one_building ON search.facet_generation USING btree (partition_no, definition) WHERE (state = 'building'::text);


--
-- Name: facet_one_ready; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX facet_one_ready ON search.facet_generation USING btree (partition_no, definition) WHERE (state = 'ready'::text);


--
-- Name: generation_publication_home_frontier; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX generation_publication_home_frontier ON search.generation_publication_home USING btree (job, pass, partition_no);


--
-- Name: identity_writer_pending; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX identity_writer_pending ON search.identity_writer USING btree (partition_no, physical_target, original_id) WHERE (writer_token IS NOT NULL);


--
-- Name: index_home_coverage_retire; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX index_home_coverage_retire ON search.index_home_coverage USING btree (consumer, index_uuid, partition_no);


--
-- Name: public_filter_coverage_behind; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_coverage_behind ON search.public_filter_coverage_home USING btree (partition_no, registration, source_home) WHERE behind;


--
-- Name: public_filter_coverage_changed; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_coverage_changed ON search.public_filter_coverage_home USING btree (partition_no, registration, last_change_generation, source_home);


--
-- Name: public_filter_observation_bootstrap; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_filter_observation_bootstrap ON search.public_filter_observation USING btree (partition_no, consumer_bootstrap) WHERE (consumer_bootstrap IS NOT NULL);


--
-- Name: public_filter_observation_publication; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_observation_publication ON search.public_filter_observation USING btree (partition_no, registration, observation DESC) WHERE (state = 'open'::text);


--
-- Name: public_filter_observation_registration; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_observation_registration ON search.public_filter_observation USING btree (partition_no, registration, observation);


--
-- Name: public_filter_pit_owned; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_pit_owned ON search.public_filter_pit USING btree (partition_no, observation, id) WHERE (state = 'owned'::text);


--
-- Name: public_filter_reference_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_reference_expiry ON search.public_filter_reference USING btree (partition_no, observation, expires_at);


--
-- Name: public_filter_registration_bootstrap; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_filter_registration_bootstrap ON search.public_filter_registration USING btree (partition_no, consumer_bootstrap) WHERE (consumer_bootstrap IS NOT NULL);


--
-- Name: public_filter_registration_publication; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_registration_publication ON search.public_filter_registration USING btree (physical_target, md5(consumer), partition_no) WHERE (state = 'active'::text);


--
-- Name: public_filter_registration_target; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_registration_target ON search.public_filter_registration USING btree (partition_no, physical_target, id);


--
-- Name: public_filter_repair_page_effects; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_repair_page_effects ON search.public_filter_repair_page USING btree (partition_no, observation, execution, ordinal) WHERE has_repairs;


--
-- Name: public_filter_target_physical; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_target_physical ON search.public_filter_target USING btree (physical_target, partition_no);


--
-- Name: public_preparation_due; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_preparation_due ON search.public_preparation USING btree (partition_no, prefix, due_at, id);


--
-- Name: public_preparation_locator; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_preparation_locator ON search.public_preparation USING btree (partition_no, prefix, kind, ((locator ->> 'key'::text)));


--
-- Name: recent_search_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX recent_search_expiry ON search.recent_search USING btree (partition_no, expires_at, route, account_id, id);


--
-- Name: recent_search_page; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX recent_search_page ON search.recent_search USING btree (partition_no, route, account_id, last_used DESC, id DESC);


--
-- Name: scope_preparation_due; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX scope_preparation_due ON search.scope_preparation USING btree (prefix, due_at, scope_id) WHERE (state = 'capture'::text);


--
-- Name: scope_preparation_ordered_page; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX scope_preparation_ordered_page ON search.scope_preparation_ordered USING btree (partition_no, prefix, scope_id, count_key, name_key, subject);


--
-- Name: scope_preparation_ordinal_page; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX scope_preparation_ordinal_page ON search.scope_preparation_ordinal USING btree (partition_no, prefix, scope_id, cut, ordinal_key, member_id);


--
-- Name: trending_member_account; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_member_account ON search.trending_member USING btree (route, account_id, term_key);


--
-- Name: trending_term_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_term_expiry ON search.trending_term USING btree (route, expires_at, term_key);


--
-- Name: trending_term_rank; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_term_rank ON search.trending_term USING btree (route, language, rank DESC, term_key);


--
-- Name: trending_term_live_rank; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_term_live_rank ON search.trending_term USING btree (route, language, rank DESC, expires_at DESC, term_key);


--
-- Name: trending_term_source; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX trending_term_source ON search.trending_term USING btree (route, source_id, term_key);


--
-- Name: public_filter_observation erasure_enroll_observation; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER erasure_enroll_observation AFTER INSERT ON search.public_filter_observation FOR EACH ROW EXECUTE FUNCTION search.enroll_retained_copy();


--
-- Name: public_filter_prepared erasure_enroll_prepared; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER erasure_enroll_prepared AFTER INSERT ON search.public_filter_prepared FOR EACH ROW EXECUTE FUNCTION search.enroll_retained_copy();


--
-- Name: public_filter_registration erasure_enroll_registration; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER erasure_enroll_registration AFTER INSERT ON search.public_filter_registration FOR EACH ROW EXECUTE FUNCTION search.enroll_retained_copy();


--
-- Name: public_filter_coverage_baseline public_filter_coverage_baseline_immutable; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_coverage_baseline_immutable BEFORE UPDATE ON search.public_filter_coverage_baseline FOR EACH ROW EXECUTE FUNCTION search.retain_public_filter_coverage_baseline();


--
-- Name: public_filter_coverage_preparation public_filter_coverage_preparation_contiguous; Type: TRIGGER; Schema: search; Owner: -
--

CREATE TRIGGER public_filter_coverage_preparation_contiguous BEFORE UPDATE ON search.public_filter_coverage_preparation FOR EACH ROW EXECUTE FUNCTION search.advance_public_filter_coverage_preparation();


--
-- Name: facet_stage facet_stage_partition_no_definition_generation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_stage
    ADD CONSTRAINT facet_stage_partition_no_definition_generation_fkey FOREIGN KEY (partition_no, definition, generation) REFERENCES search.facet_generation(partition_no, definition, generation);


--
-- Name: facet_value facet_value_partition_no_definition_generation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.facet_value
    ADD CONSTRAINT facet_value_partition_no_definition_generation_fkey FOREIGN KEY (partition_no, definition, generation) REFERENCES search.facet_generation(partition_no, definition, generation);


--
-- Name: index_incarnation index_incarnation_partition_no_prefix_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_incarnation
    ADD CONSTRAINT index_incarnation_partition_no_prefix_fkey FOREIGN KEY (partition_no, prefix) REFERENCES search.index_prefix_control(partition_no, prefix);


--
-- Name: public_filter_coverage_baseline public_filter_coverage_baseline_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_baseline
    ADD CONSTRAINT public_filter_coverage_baseline_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_coverage_home public_filter_coverage_home_baseline; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_home
    ADD CONSTRAINT public_filter_coverage_home_baseline FOREIGN KEY (partition_no, registration, baseline_bootstrap, source_home) REFERENCES search.public_filter_coverage_baseline(partition_no, registration, bootstrap, source_home);


--
-- Name: public_filter_coverage_home public_filter_coverage_home_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_home
    ADD CONSTRAINT public_filter_coverage_home_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_coverage_preparation public_filter_coverage_preparati_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_coverage_preparation
    ADD CONSTRAINT public_filter_coverage_preparati_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_execution public_filter_execution_partition_no_observation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_execution
    ADD CONSTRAINT public_filter_execution_partition_no_observation_fkey FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation(partition_no, observation);


--
-- Name: public_filter_observation public_filter_observation_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_observation
    ADD CONSTRAINT public_filter_observation_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_pit public_filter_pit_partition_no_observation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_pit
    ADD CONSTRAINT public_filter_pit_partition_no_observation_fkey FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation(partition_no, observation);


--
-- Name: public_filter_prepared public_filter_prepared_partition_no_registration_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_prepared
    ADD CONSTRAINT public_filter_prepared_partition_no_registration_fkey FOREIGN KEY (partition_no, registration) REFERENCES search.public_filter_registration(partition_no, id);


--
-- Name: public_filter_reference public_filter_reference_partition_no_observation_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_reference
    ADD CONSTRAINT public_filter_reference_partition_no_observation_fkey FOREIGN KEY (partition_no, observation) REFERENCES search.public_filter_observation(partition_no, observation);


--
-- Name: public_filter_registration public_filter_registration_partition_no_physical_target_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_registration
    ADD CONSTRAINT public_filter_registration_partition_no_physical_target_fkey FOREIGN KEY (partition_no, physical_target) REFERENCES search.public_filter_target(partition_no, physical_target);


--
-- Name: public_filter_repair_effect public_filter_repair_effect_partition_no_observation_execu_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_effect
    ADD CONSTRAINT public_filter_repair_effect_partition_no_observation_execu_fkey FOREIGN KEY (partition_no, observation, execution, page) REFERENCES search.public_filter_repair_page(partition_no, observation, execution, ordinal);


--
-- Name: public_filter_repair_page public_filter_repair_page_partition_no_observation_executi_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_repair_page
    ADD CONSTRAINT public_filter_repair_page_partition_no_observation_executi_fkey FOREIGN KEY (partition_no, observation, execution) REFERENCES search.public_filter_execution(partition_no, observation, id);


--
-- Name: recent_search recent_search_partition_no_route_account_id_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.recent_search
    ADD CONSTRAINT recent_search_partition_no_route_account_id_fkey FOREIGN KEY (partition_no, route, account_id) REFERENCES search.recent_search_state(partition_no, route, account_id) ON DELETE CASCADE;


--
-- Name: trending_member trending_member_route_term_key_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.trending_member
    ADD CONSTRAINT trending_member_route_term_key_fkey FOREIGN KEY (route, term_key) REFERENCES search.trending_term(route, term_key) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


