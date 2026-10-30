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


SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE TABLE search.identity_writer_gate (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  physical_target text COLLATE "C" NOT NULL CHECK (octet_length(physical_target) BETWEEN 1 AND 255),
  consumer text COLLATE "C" NOT NULL CHECK (consumer ~ '^[a-z][a-z0-9_]{0,62}$'),
  incarnation text NOT NULL CHECK (octet_length(incarnation) BETWEEN 1 AND 128),
  write_alias text NOT NULL CHECK (octet_length(write_alias) BETWEEN 1 AND 255),
  owner_epoch integer NOT NULL CHECK (owner_epoch > 0),
  enrollment_generation bigint NOT NULL DEFAULT 0 CHECK (enrollment_generation >= 0),
  fence_generation bigint NOT NULL DEFAULT 0 CHECK (fence_generation >= 0),
  closed_token uuid,
  closed_transaction_id uuid,
  closed_position bigint CHECK (closed_position > 0),
  PRIMARY KEY (partition_no, physical_target),
  CHECK ((closed_token IS NULL) = (closed_transaction_id IS NULL)),
  CHECK ((closed_token IS NULL) = (closed_position IS NULL)),
  CHECK ((closed_token IS NULL) = (fence_generation = 0))
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
    dispatch_state text DEFAULT 'enrolled'::text NOT NULL,
    writer_transaction_id uuid,
    writer_position bigint,
    settled_transaction_id uuid,
    settled_position bigint,
    source_position bigint,
    visible_transaction_id uuid,
    visible_position bigint CHECK (visible_position > 0),
    CHECK ((visible_transaction_id IS NULL) = (visible_position IS NULL)),
    closed_job uuid,
    closed_epoch bigint,
    closed_transaction_id uuid,
    closed_position bigint,
    CONSTRAINT identity_writer_dispatch_state_check CHECK ((dispatch_state = ANY (ARRAY['enrolled'::text, 'dispatched'::text, 'settled'::text, 'cancelled'::text]))),
    CONSTRAINT identity_writer_check CHECK (((writer_transaction_id IS NULL) = (writer_position IS NULL))),
    CONSTRAINT identity_writer_check1 CHECK (((writer_token IS NULL) OR (writer_transaction_id IS NOT NULL))),
    CONSTRAINT identity_writer_check2 CHECK (((settled_transaction_id IS NULL) = (settled_position IS NULL))),
    CONSTRAINT identity_writer_check3 CHECK (((closed_job IS NULL) = (closed_epoch IS NULL))),
    CONSTRAINT identity_writer_check4 CHECK (((closed_job IS NULL) = (closed_transaction_id IS NULL))),
    CONSTRAINT identity_writer_check5 CHECK (((closed_job IS NULL) = (closed_position IS NULL))),
    CONSTRAINT identity_writer_closed_epoch_check CHECK ((closed_epoch > 0)),
    CONSTRAINT identity_writer_closed_position_check CHECK ((closed_position > 0)),
    CONSTRAINT identity_writer_incarnation_check CHECK (((octet_length(incarnation) >= 1) AND (octet_length(incarnation) <= 128))),
    CONSTRAINT identity_writer_owner_epoch_check CHECK ((owner_epoch > 0)),
    CONSTRAINT identity_writer_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_writer_physical_target_check CHECK (((octet_length(physical_target) >= 1) AND (octet_length(physical_target) <= 255))),
    CONSTRAINT identity_writer_settled_position_check CHECK ((settled_position > 0)),
    CONSTRAINT identity_writer_source_position_check CHECK ((source_position >= 0)),
    CONSTRAINT identity_writer_writer_position_check CHECK ((writer_position > 0))
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
-- Name: public_filter_execution; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_execution (
    partition_no integer NOT NULL,
    observation text NOT NULL COLLATE pg_catalog."C",
    id text NOT NULL COLLATE pg_catalog."C",
    execution text NOT NULL,
    CONSTRAINT public_filter_execution_execution_check CHECK ((octet_length(execution) <= 1048576)),
    consumer_repair text,
    CONSTRAINT public_filter_execution_consumer_repair_check CHECK ((octet_length(consumer_repair) <= 1048576)),
    consumer_window text,
    CONSTRAINT public_filter_execution_consumer_window_check CHECK ((octet_length(consumer_window) <= 1048576))
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
    CONSTRAINT public_filter_observation_covered_check CHECK ((octet_length(covered) <= 4096)),
    CONSTRAINT public_filter_observation_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT public_filter_observation_prepared_rows_check CHECK ((octet_length(prepared_rows) <= 1048576)),
    CONSTRAINT public_filter_observation_queried_check CHECK ((octet_length(queried) <= 65536)),
    CONSTRAINT public_filter_observation_revision_check CHECK ((revision > 0)),
    CONSTRAINT public_filter_observation_state_check CHECK ((state = ANY (ARRAY['open'::text, 'closing'::text, 'closed'::text]))),
    consumer_work text,
    consumer_bootstrap text,
    CONSTRAINT public_filter_observation_consumer_work_check CHECK ((octet_length(consumer_work) <= 1048576))
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
    CONSTRAINT public_filter_prepared_generation_check CHECK (((generation > (0)::numeric) AND (scale(generation) = 0))),
    CONSTRAINT public_filter_prepared_rows_check CHECK ((octet_length(rows) <= 1048576))
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
    CONSTRAINT public_filter_registration_consumer_check CHECK ((octet_length(consumer) <= 8192)),
    CONSTRAINT public_filter_registration_definition_check CHECK ((octet_length(definition) <= 1048576)),
    CONSTRAINT public_filter_registration_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT public_filter_registration_state_check CHECK ((state = ANY (ARRAY['active'::text, 'retired'::text]))),
    consumer_work text,
    consumer_bootstrap text,
    CONSTRAINT public_filter_registration_consumer_work_check CHECK ((octet_length(consumer_work) <= 1048576))
);


--
-- Name: public_filter_target; Type: TABLE; Schema: search; Owner: -
--

CREATE TABLE search.public_filter_target (
    partition_no integer NOT NULL,
    physical_target text NOT NULL COLLATE pg_catalog."C",
    incarnation text NOT NULL,
    CONSTRAINT public_filter_target_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095)))
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
-- Name: identity_writer identity_writer_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.identity_writer
    ADD CONSTRAINT identity_writer_pkey PRIMARY KEY (partition_no, physical_target, original_id);


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
-- Name: public_filter_target public_filter_target_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_filter_target
    ADD CONSTRAINT public_filter_target_pkey PRIMARY KEY (partition_no, physical_target);


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
-- Name: public_preparation public_preparation_pkey; Type: CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.public_preparation
    ADD CONSTRAINT public_preparation_pkey PRIMARY KEY (partition_no, id);


--
-- Name: index_home_coverage_retire; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX index_home_coverage_retire ON search.index_home_coverage USING btree (consumer, index_uuid, partition_no);


--
-- Name: public_filter_pit_owned; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_pit_owned ON search.public_filter_pit USING btree (partition_no, observation, id) WHERE (state = 'owned'::text);


--
-- Name: public_filter_reference_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_filter_reference_expiry ON search.public_filter_reference USING btree (partition_no, observation, expires_at);


--
-- Name: recent_search_expiry; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX recent_search_expiry ON search.recent_search USING btree (partition_no, expires_at, route, account_id, id);


--
-- Name: recent_search_page; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX recent_search_page ON search.recent_search USING btree (partition_no, route, account_id, last_used DESC, id DESC);


--
-- Name: public_preparation_due; Type: INDEX; Schema: search; Owner: -
--

CREATE INDEX public_preparation_due ON search.public_preparation USING btree (partition_no, prefix, due_at, id);


--
-- Name: public_preparation_locator; Type: INDEX; Schema: search; Owner: -
--

CREATE UNIQUE INDEX public_preparation_locator ON search.public_preparation USING btree (partition_no, prefix, kind, ((locator ->> 'key'::text)));


--
-- Name: index_incarnation index_incarnation_partition_no_prefix_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.index_incarnation
    ADD CONSTRAINT index_incarnation_partition_no_prefix_fkey FOREIGN KEY (partition_no, prefix) REFERENCES search.index_prefix_control(partition_no, prefix);


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
-- Name: recent_search recent_search_partition_no_route_account_id_fkey; Type: FK CONSTRAINT; Schema: search; Owner: -
--

ALTER TABLE ONLY search.recent_search
    ADD CONSTRAINT recent_search_partition_no_route_account_id_fkey FOREIGN KEY (partition_no, route, account_id) REFERENCES search.recent_search_state(partition_no, route, account_id) ON DELETE CASCADE;


-- Private bounded projection, never public eligibility evidence. Current owner bindings gate activation.
CREATE TABLE search.trending_term (
  route integer NOT NULL CHECK (route = 0),
  term_key text COLLATE "C" NOT NULL CHECK (term_key ~ '^[0-9a-f]{64}$'),
  language text NOT NULL CHECK (octet_length(language) <= 35),
  source_id uuid NOT NULL,
  display text NOT NULL CHECK (octet_length(display) BETWEEN 1 AND 256),
  rank integer NOT NULL CHECK (rank BETWEEN 0 AND 16),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (route, term_key)
);
CREATE INDEX trending_term_rank ON search.trending_term(route, language, rank DESC, term_key);
CREATE INDEX trending_term_expiry ON search.trending_term(route, expires_at, term_key);
CREATE INDEX trending_term_source ON search.trending_term(route, source_id, term_key);
CREATE TABLE search.trending_member (
  route integer NOT NULL CHECK (route = 0),
  term_key text COLLATE "C" NOT NULL,
  account_id uuid NOT NULL,
  day date NOT NULL,
  contributed_at timestamptz NOT NULL,
  PRIMARY KEY (route, term_key, account_id),
  FOREIGN KEY (route, term_key) REFERENCES search.trending_term ON DELETE CASCADE
);
CREATE INDEX trending_member_account ON search.trending_member(route, account_id, term_key);
CREATE TABLE search.trending_blocked (
  route integer NOT NULL CHECK (route = 0),
  kind text NOT NULL CHECK (kind IN ('account', 'source')),
  identity uuid NOT NULL,
  PRIMARY KEY (route, kind, identity)
);


-- PostgreSQL database dump complete
--



CREATE INDEX identity_writer_pending ON search.identity_writer USING btree (partition_no, physical_target, original_id) WHERE (writer_token IS NOT NULL);

-- Retained bounded publication work over the existing native generation authorities.
CREATE TABLE search.generation_publication (
    partition_no integer DEFAULT 0 NOT NULL CHECK (partition_no = 0),
    job uuid NOT NULL,
    physical_target text COLLATE pg_catalog."C" NOT NULL,
    consumer jsonb NOT NULL CHECK (octet_length(consumer::text) <= 8192),
    prefix text COLLATE pg_catalog."C" NOT NULL,
    generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
    family text NOT NULL CHECK (family IN ('subjects', 'discovery')),
    native_incarnation text NOT NULL,
    pass bigint DEFAULT 1 NOT NULL CHECK (pass > 0),
    activated_at text NOT NULL,
    kinds text[] NOT NULL,
    source_home integer NOT NULL CHECK (source_home BETWEEN 0 AND 4095),
    binding jsonb NOT NULL CHECK (octet_length(binding::text) <= 8192),
    phase text DEFAULT 'subject' NOT NULL CHECK (phase IN ('subject','account','engine','validate','reconciled','fencing','intent','active')),
    home integer DEFAULT 0 NOT NULL CHECK (home BETWEEN 0 AND 4096),
    after_route integer,
    after_id uuid,
    engine_after jsonb CHECK (octet_length(engine_after::text) <= 8192),
    pit text CHECK (octet_length(pit) <= 65536),
    fence text CHECK (octet_length(fence) <= 8192),
    fenced_pass boolean DEFAULT false NOT NULL,
    observation text,
    previous_target text,
    previous_uuid text,
    revision bigint DEFAULT 1 NOT NULL CHECK (revision > 0),
    PRIMARY KEY (partition_no,job),
    UNIQUE (partition_no,physical_target,consumer),
    CHECK ((after_route IS NULL) = (after_id IS NULL))
);
CREATE TABLE search.generation_publication_home (
    partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
    job uuid NOT NULL,
    pass bigint NOT NULL CHECK (pass > 0),
    epoch integer NOT NULL,
    position bigint NOT NULL CHECK (position >= 0),
    account_revision bigint DEFAULT 0 NOT NULL,
    claim_revision bigint DEFAULT 0 NOT NULL,
    PRIMARY KEY (partition_no,job)
);
CREATE INDEX generation_publication_home_frontier
  ON search.generation_publication_home(job,pass,partition_no);
CREATE INDEX public_filter_registration_publication ON search.public_filter_registration USING btree
    (physical_target,md5(consumer),partition_no) WHERE state = 'active';
CREATE INDEX public_filter_observation_publication ON search.public_filter_observation USING btree
    (partition_no,registration,observation DESC) WHERE state = 'open';

ALTER TABLE search.identity_writer_gate
  ADD COLUMN publication_job uuid,
  ADD COLUMN publication_consumer jsonb CHECK (octet_length(publication_consumer::text)<=8192),
  ADD COLUMN publication_fence uuid,
  ADD COLUMN publication_released_fence uuid,
  ADD COLUMN publication_home integer NOT NULL DEFAULT 0 CHECK (publication_home BETWEEN 0 AND 4096),
  ADD COLUMN publication_after uuid,
  ADD COLUMN publication_revision bigint NOT NULL DEFAULT 0 CHECK (publication_revision>=0),
  ADD CHECK (publication_fence IS NULL OR (publication_job IS NOT NULL AND publication_consumer IS NOT NULL)),
  ADD CHECK (partition_no=0 OR publication_job IS NULL);

CREATE UNIQUE INDEX public_filter_observation_bootstrap ON search.public_filter_observation(partition_no,consumer_bootstrap) WHERE consumer_bootstrap IS NOT NULL;
CREATE UNIQUE INDEX public_filter_registration_bootstrap ON search.public_filter_registration(partition_no,consumer_bootstrap) WHERE consumer_bootstrap IS NOT NULL;
CREATE TABLE search.scope_preparation (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  prefix text COLLATE "C" NOT NULL,
  scope_id text COLLATE "C" NOT NULL CHECK (scope_id ~ '^[0-9a-f]{64}$'),
  definition jsonb NOT NULL CHECK (octet_length(definition::text)<=262144),
  frontier jsonb NOT NULL CHECK (octet_length(frontier::text)<=8192),
  observation jsonb CHECK (octet_length(observation::text)<=8192),
  ordinal_membership_progress jsonb CHECK (octet_length(ordinal_membership_progress::text)<=8192),
  leaf_progress jsonb CHECK (octet_length(leaf_progress::text)<=4096),
  ordinal_frontier jsonb CHECK (octet_length(ordinal_frontier::text)<=1024),
  ordinal_complete boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'capture' CHECK (state IN ('capture','ready','retained')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  lease_until bigint NOT NULL DEFAULT 0,
  due_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (partition_no,prefix,scope_id)
);
CREATE INDEX scope_preparation_due ON search.scope_preparation(prefix,due_at,scope_id) WHERE state='capture';


CREATE TABLE search.scope_preparation_ordinal (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no=0),
  prefix text COLLATE "C" NOT NULL,
  scope_id text COLLATE "C" NOT NULL,
  cut text COLLATE "C" NOT NULL CHECK (cut ~ '^[0-9a-f]{64}$'),
  subject uuid NOT NULL,
  ordinal_key text COLLATE "C" NOT NULL CHECK (octet_length(ordinal_key)<=256),
  member_id uuid NOT NULL,
  PRIMARY KEY (partition_no,prefix,scope_id,cut,subject)
);
CREATE INDEX scope_preparation_ordinal_page ON search.scope_preparation_ordinal
  (partition_no,prefix,scope_id,cut,ordinal_key,member_id);

-- Children of the existing retained execution, not a second consumer registry.
ALTER TABLE search.public_filter_execution ADD COLUMN repair_settlement text
  CHECK (octet_length(repair_settlement)<=16384);
CREATE TABLE search.public_filter_repair_page (
  partition_no integer NOT NULL,
  observation text COLLATE "C" NOT NULL,
  execution text COLLATE "C" NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal>=0),
  has_repairs boolean NOT NULL,
  intent text NOT NULL CHECK (octet_length(intent)<=1048576),
  PRIMARY KEY (partition_no,observation,execution,ordinal),
  FOREIGN KEY (partition_no,observation,execution)
    REFERENCES search.public_filter_execution(partition_no,observation,id)
);
CREATE TABLE search.public_filter_repair_effect (
  partition_no integer NOT NULL,
  observation text COLLATE "C" NOT NULL,
  execution text COLLATE "C" NOT NULL,
  page integer NOT NULL,
  item integer NOT NULL CHECK (item>=0),
  receipt text NOT NULL CHECK (octet_length(receipt)<=1048576),
  PRIMARY KEY (partition_no,observation,execution,page,item),
  FOREIGN KEY (partition_no,observation,execution,page)
    REFERENCES search.public_filter_repair_page(partition_no,observation,execution,ordinal)
);
CREATE INDEX public_filter_repair_page_effects ON search.public_filter_repair_page
  (partition_no,observation,execution,ordinal) WHERE has_repairs;
-- The actual writer retains its exact pre-dispatch body and recovery locator in its own home.
ALTER TABLE search.identity_writer ADD COLUMN repair_locator text CHECK (octet_length(repair_locator)<=8192),
  ADD COLUMN repair_action text CHECK (octet_length(repair_action)<=1048576),
  ADD COLUMN repair_receipt text CHECK (octet_length(repair_receipt)<=1048576);

