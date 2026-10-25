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
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: editorial; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA editorial;


--
-- Name: semantic; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA semantic;


--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: outbox; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.outbox (
    partition_no integer NOT NULL,
    "position" bigint NOT NULL,
    event_seq integer NOT NULL,
    event_count integer NOT NULL,
    epoch integer NOT NULL,
    id uuid NOT NULL,
    type text NOT NULL,
    subject text,
    data jsonb NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT outbox_check CHECK (((event_seq >= 0) AND (event_seq < event_count))),
    CONSTRAINT outbox_event_count_check CHECK ((event_count > 0)),
    CONSTRAINT outbox_position_check CHECK (("position" > 0))
);


--
-- Name: partition; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.partition (
    partition_no integer NOT NULL,
    node text NOT NULL,
    write_state text DEFAULT 'active'::text NOT NULL,
    moved_to text,
    epoch integer DEFAULT 1 NOT NULL,
    "position" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT partition_check CHECK (((write_state = 'moved'::text) = (moved_to IS NOT NULL))),
    CONSTRAINT partition_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT partition_partition_no_check CHECK ((partition_no >= 0)),
    CONSTRAINT partition_position_check CHECK (("position" >= 0)),
    CONSTRAINT partition_write_state_check CHECK ((write_state = ANY (ARRAY['active'::text, 'fenced'::text, 'moved'::text])))
);


--
-- Name: receipt; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.receipt (
    partition_no integer NOT NULL,
    actor_account_id uuid NOT NULL,
    command_kind text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest bytea NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    transaction_id uuid NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT receipt_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT receipt_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255))),
    CONSTRAINT receipt_position_check CHECK (("position" > 0)),
    CONSTRAINT receipt_request_digest_check CHECK ((octet_length(request_digest) = 32))
);


--
-- Name: write_basis; Type: TABLE; Schema: editorial; Owner: -
--

CREATE TABLE editorial.write_basis (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    actor_account_id uuid NOT NULL,
    client_id text NOT NULL,
    requested_by text,
    recorded_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT write_basis_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT write_basis_position_check CHECK (("position" > 0))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: fact; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.fact (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    log_seq integer NOT NULL,
    operation text NOT NULL,
    kind text NOT NULL,
    language text,
    property text,
    statement_id uuid,
    body jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT fact_check CHECK ((((kind = ANY (ARRAY['label'::text, 'description'::text, 'alias'::text])) AND (language IS NOT NULL) AND (property IS NULL) AND (statement_id IS NULL)) OR ((kind = 'statement'::text) AND (language IS NULL) AND (property IS NOT NULL) AND (statement_id IS NOT NULL)))),
    CONSTRAINT fact_kind_check CHECK ((kind = ANY (ARRAY['label'::text, 'description'::text, 'alias'::text, 'statement'::text]))),
    CONSTRAINT fact_log_seq_check CHECK (((log_seq >= 1) AND (log_seq <= 32))),
    CONSTRAINT fact_operation_check CHECK ((operation = ANY (ARRAY['assert'::text, 'retract'::text])))
);


--
-- Name: subject; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    type text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT subject_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_type_check CHECK ((type = 'schema:Book'::text))
);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (partition_no, "position", event_seq);


--
-- Name: partition partition_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.partition
    ADD CONSTRAINT partition_pkey PRIMARY KEY (partition_no);


--
-- Name: receipt receipt_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.receipt
    ADD CONSTRAINT receipt_pkey PRIMARY KEY (partition_no, actor_account_id, command_kind, idempotency_key);


--
-- Name: write_basis write_basis_partition_no_position_key; Type: CONSTRAINT; Schema: editorial; Owner: -
--

ALTER TABLE ONLY editorial.write_basis
    ADD CONSTRAINT write_basis_partition_no_position_key UNIQUE (partition_no, "position");


--
-- Name: write_basis write_basis_pkey; Type: CONSTRAINT; Schema: editorial; Owner: -
--

ALTER TABLE ONLY editorial.write_basis
    ADD CONSTRAINT write_basis_pkey PRIMARY KEY (partition_no, transaction_id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: fact fact_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.fact
    ADD CONSTRAINT fact_pkey PRIMARY KEY (route, subject_id, slot_id, log_seq);


--
-- Name: subject subject_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject
    ADD CONSTRAINT subject_pkey PRIMARY KEY (route, subject_id);


--
-- Name: outbox outbox_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.outbox
    ADD CONSTRAINT outbox_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: receipt receipt_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.receipt
    ADD CONSTRAINT receipt_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: write_basis write_basis_partition_no_fkey; Type: FK CONSTRAINT; Schema: editorial; Owner: -
--

ALTER TABLE ONLY editorial.write_basis
    ADD CONSTRAINT write_basis_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: fact fact_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.fact
    ADD CONSTRAINT fact_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- PostgreSQL database dump complete
--


