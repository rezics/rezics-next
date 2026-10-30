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
    CONSTRAINT public_filter_execution_execution_check CHECK ((octet_length(execution) <= 1048576))
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
    CONSTRAINT public_filter_registration_state_check CHECK ((state = ANY (ARRAY['active'::text, 'retired'::text])))
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
-- PostgreSQL database dump complete
--


