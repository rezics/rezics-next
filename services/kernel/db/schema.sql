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


--
-- Name: history_store_kind; Type: TYPE; Schema: core; Owner: -
--

CREATE TYPE core.history_store_kind AS ENUM (
    'kernel'
);


--
-- Name: history_guard_locator(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_guard_locator() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE guard_phase text;
BEGIN
  INSERT INTO core.history_seal (partition_no, account_route, account_id)
    VALUES (NEW.partition_no, NEW.account_route, NEW.account_id) ON CONFLICT DO NOTHING;
  SELECT phase INTO STRICT guard_phase FROM core.history_seal
    WHERE partition_no = NEW.partition_no AND account_route = NEW.account_route AND account_id = NEW.account_id
    FOR SHARE;
  IF guard_phase <> 'open' THEN
    RAISE EXCEPTION 'history account partition is sealed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: history_preserve_seal(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.history_preserve_seal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.phase <> 'open' THEN
      RAISE EXCEPTION 'history seal is irreversible' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.partition_no, NEW.account_route, NEW.account_id) IS DISTINCT FROM
     (OLD.partition_no, OLD.account_route, OLD.account_id) OR
     (OLD.phase <> 'open' AND (NEW.barrier_id IS DISTINCT FROM OLD.barrier_id OR NEW.phase = 'open')) OR
     (OLD.phase = 'complete' AND NEW.phase <> 'complete') THEN
    RAISE EXCEPTION 'history seal is irreversible' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


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
-- Name: consumer_lag; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.consumer_lag (
    consumer text NOT NULL,
    oldest_pending_at timestamp with time zone,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT consumer_lag_consumer_check CHECK ((consumer ~ '^[a-z][a-z0-9_]{0,62}$'::text))
-- Name: history_locator; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_locator (
    partition_no integer NOT NULL,
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    artifact_type text NOT NULL COLLATE pg_catalog."C",
    locator bytea NOT NULL,
    roles integer NOT NULL,
    minimizer_version integer NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    proof_barrier uuid,
    CONSTRAINT history_locator_account_route_check CHECK (((account_route >= 0) AND (account_route <= 65535))),
    CONSTRAINT history_locator_artifact_type_check CHECK ((artifact_type = ANY (ARRAY['command-receipt/v1'::text, 'outbox-event/v1'::text, 'durable-work/v1'::text]))),
    CONSTRAINT history_locator_check CHECK ((account_route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT history_locator_check1 CHECK ((((state = 'pending'::text) AND (proof_barrier IS NULL)) OR ((state = 'minimized'::text) AND (proof_barrier IS NOT NULL) AND (proof_barrier = account_id)))),
    CONSTRAINT history_locator_locator_check CHECK (((octet_length(locator) >= 1) AND (octet_length(locator) <= 256))),
    CONSTRAINT history_locator_minimizer_version_check CHECK ((minimizer_version = 1)),
    CONSTRAINT history_locator_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT history_locator_roles_check CHECK (((roles >= 1) AND (roles <= 63))),
    CONSTRAINT history_locator_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'minimized'::text])))
);


--
-- Name: history_progress; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_progress (
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    barrier_id uuid NOT NULL,
    store_kind core.history_store_kind NOT NULL,
    partition_no integer NOT NULL,
    partition_epoch integer NOT NULL,
    artifact_type text COLLATE pg_catalog."C",
    locator bytea,
    state text DEFAULT 'pending'::text NOT NULL,
    proof text,
    CONSTRAINT history_progress_account_route_check CHECK (((account_route >= 0) AND (account_route <= 65535))),
    CONSTRAINT history_progress_artifact_type_check CHECK ((artifact_type = ANY (ARRAY['command-receipt/v1'::text, 'outbox-event/v1'::text, 'durable-work/v1'::text]))),
    CONSTRAINT history_progress_check CHECK ((barrier_id = account_id)),
    CONSTRAINT history_progress_check1 CHECK ((account_route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT history_progress_check2 CHECK (((artifact_type IS NULL) = (locator IS NULL))),
    CONSTRAINT history_progress_check3 CHECK (((state = 'pending'::text) = (proof IS NULL))),
    CONSTRAINT history_progress_locator_check CHECK (((octet_length(locator) >= 1) AND (octet_length(locator) <= 256))),
    CONSTRAINT history_progress_partition_epoch_check CHECK ((partition_epoch > 0)),
    CONSTRAINT history_progress_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT history_progress_proof_check CHECK ((proof = ANY (ARRAY['erased'::text, 'none'::text]))),
    CONSTRAINT history_progress_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'complete'::text])))
);


--
-- Name: history_seal; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_seal (
    partition_no integer NOT NULL,
    account_route integer NOT NULL,
    account_id uuid NOT NULL,
    barrier_id uuid,
    phase text DEFAULT 'open'::text NOT NULL,
    CONSTRAINT history_seal_account_route_check CHECK (((account_route >= 0) AND (account_route <= 65535))),
    CONSTRAINT history_seal_check CHECK ((account_route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT history_seal_check1 CHECK ((((phase = 'open'::text) AND (barrier_id IS NULL)) OR ((phase <> 'open'::text) AND (barrier_id IS NOT NULL) AND (barrier_id = account_id)))),
    CONSTRAINT history_seal_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT history_seal_phase_check CHECK ((phase = ANY (ARRAY['open'::text, 'sealed'::text, 'complete'::text])))
);


--
-- Name: history_work; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.history_work (
    partition_no integer NOT NULL,
    work_id uuid NOT NULL,
    request_digest bytea NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    owner_ready boolean DEFAULT false NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT history_work_check CHECK (((state <> 'ready'::text) OR owner_ready)),
    CONSTRAINT history_work_check1 CHECK (((state = 'retired'::text) = (retired_at IS NOT NULL))),
    CONSTRAINT history_work_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT history_work_request_digest_check CHECK ((octet_length(request_digest) = 32)),
    CONSTRAINT history_work_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'ready'::text, 'retired'::text])))
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
-- Name: consumer_lag consumer_lag_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consumer_lag
    ADD CONSTRAINT consumer_lag_pkey PRIMARY KEY (consumer);
-- Name: history_locator history_locator_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_locator
    ADD CONSTRAINT history_locator_pkey PRIMARY KEY (partition_no, account_route, account_id, artifact_type, locator);


--
-- Name: history_progress history_progress_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_progress
    ADD CONSTRAINT history_progress_pkey PRIMARY KEY (account_route, account_id, barrier_id, store_kind, partition_no);


--
-- Name: history_seal history_seal_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_seal
    ADD CONSTRAINT history_seal_pkey PRIMARY KEY (partition_no, account_route, account_id);


--
-- Name: history_work history_work_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_work
    ADD CONSTRAINT history_work_pkey PRIMARY KEY (partition_no, work_id);


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
-- Name: history_locator_pending; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX history_locator_pending ON core.history_locator USING btree (partition_no, account_route, account_id, artifact_type, locator) WHERE (state = 'pending'::text);


--
-- Name: history_locator history_locator_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_locator_guard BEFORE INSERT OR UPDATE OF partition_no, account_route, account_id, artifact_type, locator, roles, minimizer_version ON core.history_locator FOR EACH ROW EXECUTE FUNCTION core.history_guard_locator();


--
-- Name: history_seal history_seal_preserve; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER history_seal_preserve BEFORE DELETE OR UPDATE ON core.history_seal FOR EACH ROW EXECUTE FUNCTION core.history_preserve_seal();


--
-- Name: consumer_checkpoint consumer_checkpoint_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consumer_checkpoint
    ADD CONSTRAINT consumer_checkpoint_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_locator history_locator_account_route_proof_barrier_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_locator
    ADD CONSTRAINT history_locator_account_route_proof_barrier_fkey FOREIGN KEY (account_route, proof_barrier) REFERENCES access.erasure(route, account_id);


--
-- Name: history_locator history_locator_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_locator
    ADD CONSTRAINT history_locator_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_progress history_progress_account_route_barrier_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_progress
    ADD CONSTRAINT history_progress_account_route_barrier_id_fkey FOREIGN KEY (account_route, barrier_id) REFERENCES access.erasure(route, account_id);


--
-- Name: history_progress history_progress_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_progress
    ADD CONSTRAINT history_progress_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_seal history_seal_account_route_barrier_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_seal
    ADD CONSTRAINT history_seal_account_route_barrier_id_fkey FOREIGN KEY (account_route, barrier_id) REFERENCES access.erasure(route, account_id);


--
-- Name: history_seal history_seal_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_seal
    ADD CONSTRAINT history_seal_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


--
-- Name: history_work history_work_partition_no_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.history_work
    ADD CONSTRAINT history_work_partition_no_fkey FOREIGN KEY (partition_no) REFERENCES core.partition(partition_no);


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


