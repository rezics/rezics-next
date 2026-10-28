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
-- Name: consumer_checkpoint; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.consumer_checkpoint (
    partition_no integer NOT NULL,
    consumer text NOT NULL,
    epoch integer,
    "position" bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT consumer_checkpoint_check CHECK (((epoch IS NULL) = ("position" = 0))),
    CONSTRAINT consumer_checkpoint_consumer_check CHECK ((consumer ~ '^[a-z][a-z0-9_]{0,62}$'::text)),
    CONSTRAINT consumer_checkpoint_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT consumer_checkpoint_position_check CHECK (("position" >= 0))
);


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
    principal_id uuid CONSTRAINT receipt_actor_account_id_not_null NOT NULL,
    command_kind text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest bytea NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    transaction_id uuid NOT NULL,
    response jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    principal_kind text NOT NULL,
    actor_account_id uuid GENERATED ALWAYS AS (
CASE
    WHEN (principal_kind = 'account'::text) THEN principal_id
    ELSE NULL::uuid
END) STORED,
    CONSTRAINT receipt_anonymous_key_check CHECK (((principal_kind <> 'anonymous'::text) OR (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))),
    CONSTRAINT receipt_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT receipt_idempotency_key_check CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255))),
    CONSTRAINT receipt_position_check CHECK (("position" >= 0)),
    CONSTRAINT receipt_principal_check CHECK ((((principal_kind = 'account'::text) AND (principal_id <> '00000000-0000-0000-0000-000000000000'::uuid)) OR ((principal_kind = 'anonymous'::text) AND (principal_id = '00000000-0000-0000-0000-000000000000'::uuid)))),
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
    principal_id uuid CONSTRAINT write_basis_actor_account_id_not_null NOT NULL,
    client_id text,
    requested_by text,
    recorded_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    principal_kind text NOT NULL,
    actor_account_id uuid GENERATED ALWAYS AS (
CASE
    WHEN (principal_kind = 'account'::text) THEN principal_id
    ELSE NULL::uuid
END) STORED,
    CONSTRAINT write_basis_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT write_basis_position_check CHECK (("position" > 0)),
    CONSTRAINT write_basis_principal_check CHECK ((((principal_kind = 'account'::text) AND (principal_id <> '00000000-0000-0000-0000-000000000000'::uuid) AND (client_id IS NOT NULL)) OR ((principal_kind = 'anonymous'::text) AND (principal_id = '00000000-0000-0000-0000-000000000000'::uuid) AND (client_id IS NULL) AND (requested_by IS NULL))))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    version character varying NOT NULL
);


--
-- Name: consumer_checkpoint consumer_checkpoint_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consumer_checkpoint
    ADD CONSTRAINT consumer_checkpoint_pkey PRIMARY KEY (partition_no, consumer);


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
    ADD CONSTRAINT receipt_pkey PRIMARY KEY (partition_no, principal_kind, principal_id, command_kind, idempotency_key);


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
-- Name: consumer_checkpoint_consumer_idx; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX consumer_checkpoint_consumer_idx ON core.consumer_checkpoint USING btree (consumer, partition_no);


--
-- Name: consumer_checkpoint consumer_checkpoint_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consumer_checkpoint
    ADD CONSTRAINT consumer_checkpoint_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


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
-- PostgreSQL database dump complete
--


