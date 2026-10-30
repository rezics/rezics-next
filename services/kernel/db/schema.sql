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
);


--
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
    CONSTRAINT history_locator_roles_check CHECK (((roles >= 1) AND (roles <= 262143))),
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
    payload_state text DEFAULT 'present'::text NOT NULL,
    CONSTRAINT receipt_payload_state_check CHECK (payload_state IN ('present','minimized')),
    CONSTRAINT receipt_minimized_response CHECK (payload_state <> 'minimized' OR response = 'null'::jsonb),
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    principal_kind text NOT NULL,
    actor_account_id uuid GENERATED ALWAYS AS (
CASE
    WHEN (principal_kind = 'account'::text) THEN principal_id
    ELSE NULL::uuid
END) STORED,
    CONSTRAINT receipt_anonymous_key_check CHECK (((principal_kind <> 'anonymous'::text) OR (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) OR (idempotency_key ~ '^rk1\.(0|[1-9][0-9]{0,2})\.[A-Za-z0-9_-]{43}$'::text))),
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


--
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



-- Native preference receipt applicability, independent of DBOS.
CREATE TABLE core.preference_history_job (
  job_id uuid PRIMARY KEY,
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  account_route integer NOT NULL,
  account_id uuid NOT NULL,
  barrier_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','covered-pending')),
  cursor bytea CHECK (octet_length(cursor) BETWEEN 1 AND 256),
  CHECK (barrier_id = account_id),
  CHECK (partition_no = (account_route >> 4)),
  FOREIGN KEY (account_route,barrier_id) REFERENCES access.erasure(route,account_id)
);
CREATE INDEX history_locator_artifact ON core.history_locator
  (partition_no,artifact_type,locator,account_route,account_id);


ALTER TABLE core.outbox ADD COLUMN payload_state text NOT NULL DEFAULT 'present'
  CHECK (payload_state IN ('present','minimized'));
ALTER TABLE core.outbox ADD CONSTRAINT outbox_minimized_payload
  CHECK (payload_state <> 'minimized' OR (data='{}'::jsonb AND subject IS NULL));

-- Extend the existing native job; the default worker no longer starts a preference-only execution.
ALTER TABLE core.preference_history_job
  ADD COLUMN scan_partition integer NOT NULL DEFAULT 0 CHECK(scan_partition BETWEEN 0 AND 4096),
  ADD COLUMN scan_type text COLLATE "C",
  ADD COLUMN scan_locator bytea CHECK(octet_length(scan_locator) BETWEEN 1 AND 256),
  ADD COLUMN phase text NOT NULL DEFAULT 'scan' CHECK(phase IN ('scan','pending')),
  ADD COLUMN applicable boolean NOT NULL DEFAULT false,
  ADD COLUMN next_run timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN gap text CHECK(octet_length(gap)<=2048),
  ADD CONSTRAINT history_job_cursor CHECK((scan_type IS NULL)=(scan_locator IS NULL));
CREATE INDEX preference_history_runnable ON core.preference_history_job(next_run,job_id) WHERE phase='scan';
CREATE UNIQUE INDEX preference_history_barrier ON core.preference_history_job(account_route,account_id,barrier_id);
ALTER TABLE core.history_progress ADD COLUMN coverage_gap text CHECK(octet_length(coverage_gap)<=2048);

-- Owner dispositions outlive DBOS history. An effects checkpoint proves enqueue only.
CREATE TABLE core.history_event_consumer (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  position bigint NOT NULL CHECK(position>0), event_seq integer NOT NULL CHECK(event_seq BETWEEN 0 AND 999),
  consumer text COLLATE "C" NOT NULL CHECK(consumer ~ '^[a-z][a-z0-9_]{0,62}$'),
  workflow_id text NOT NULL CHECK(octet_length(workflow_id)<=256),
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','completed','transferred','suppressed')),
  PRIMARY KEY(partition_no,position,event_seq,consumer), UNIQUE(workflow_id)
);

ALTER TABLE core.history_work
  ADD COLUMN owner text CHECK(owner ~ '^[a-z][a-z0-9_.-]{0,95}$'),
  ADD COLUMN request jsonb CHECK(octet_length(request::text)<=65536),
  ADD COLUMN scope jsonb CHECK(octet_length(scope::text)<=16384),
  ADD COLUMN source_partition integer CHECK(source_partition BETWEEN 0 AND 4095),
  ADD COLUMN source_transaction uuid,
  ADD COLUMN admitted boolean NOT NULL DEFAULT false,
  ADD COLUMN absence_verified boolean NOT NULL DEFAULT false;
CREATE INDEX history_work_source ON core.history_work(source_partition,work_id);


-- Native jobs contain account/barrier progress. Cleanup never copies those values into DBOS.
ALTER TABLE core.preference_history_job
  DROP CONSTRAINT preference_history_job_phase_check,
  ADD CONSTRAINT preference_history_job_phase_check CHECK(phase IN ('scan','verify','pending','complete')),
  ADD COLUMN barrier_version integer,
  ADD COLUMN barrier_at text,
  ADD COLUMN registry_digest text,
  ADD COLUMN verify_partition integer NOT NULL DEFAULT 0 CHECK(verify_partition BETWEEN 0 AND 4096);
CREATE INDEX history_job_pending ON core.preference_history_job(job_id) WHERE phase='pending';
ALTER TABLE core.history_progress ADD COLUMN applicable boolean NOT NULL DEFAULT false;
CREATE INDEX history_progress_pending ON core.history_progress(account_route,account_id,barrier_id,store_kind,partition_no)
  WHERE state='pending';

-- A consumer transition or a supported owner explicitly redrives only the affected native job.
CREATE FUNCTION core.history_wake_account(p_route integer,p_account uuid) RETURNS void LANGUAGE sql AS $$
 UPDATE core.preference_history_job SET phase='scan',scan_partition=0,scan_type=NULL,scan_locator=NULL,
   verify_partition=0,gap=NULL,next_run=now()
 WHERE account_route=p_route AND account_id=p_account AND phase='pending';
$$;
CREATE FUNCTION core.history_consumer_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; k bytea;
BEGIN
 IF OLD.state=NEW.state THEN RETURN NEW; END IF;
 k:=decode('0102','hex') || int2send(NEW.partition_no::smallint) || int8send(NEW.position) || int2send(NEW.event_seq::smallint);
 FOR r IN SELECT account_route,account_id FROM core.history_locator
   WHERE partition_no=NEW.partition_no AND artifact_type='outbox-event/v1' AND locator=k
   ORDER BY account_route,account_id LIMIT 64
 LOOP PERFORM core.history_wake_account(r.account_route,r.account_id); END LOOP;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_consumer_changed AFTER UPDATE OF state ON core.history_event_consumer
 FOR EACH ROW EXECUTE FUNCTION core.history_consumer_changed();


CREATE TABLE core.history_registry (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
  digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
  gaps jsonb NOT NULL CHECK(jsonb_typeof(gaps)='array' AND octet_length(gaps::text)<=4096)
);
ALTER TABLE core.preference_history_job ADD COLUMN registry_generation bigint NOT NULL DEFAULT 0;
CREATE INDEX history_registry_redrive ON core.preference_history_job(registry_generation,job_id);
DROP INDEX core.preference_history_runnable;
CREATE INDEX preference_history_runnable ON core.preference_history_job(next_run,job_id)
  WHERE phase IN ('scan','verify');
-- Proof rows are issued only by physical minimizers. A later account sharing an already
-- minimized copy receives its own barrier proof without reintroducing the payload.
CREATE TABLE core.history_receiving_proof (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  account_route integer NOT NULL, account_id uuid NOT NULL,
  artifact_type text COLLATE "C" NOT NULL, locator bytea NOT NULL,
  barrier_version integer NOT NULL CHECK(barrier_version>0), barrier_at text NOT NULL,
  partition_epoch integer NOT NULL CHECK(partition_epoch>0),
  role_digest bytea NOT NULL CHECK(octet_length(role_digest)=32),
  PRIMARY KEY(partition_no,account_route,account_id,artifact_type,locator,partition_epoch),
  FOREIGN KEY(partition_no,account_route,account_id,artifact_type,locator)
    REFERENCES core.history_locator(partition_no,account_route,account_id,artifact_type,locator)
);
-- Custody evidence can only move forward. A proof cannot outlive a rewritten source scope.
CREATE FUNCTION core.history_receiving_proof_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'history receiving proof is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER history_receiving_proof_immutable BEFORE UPDATE OR DELETE ON core.history_receiving_proof
 FOR EACH ROW EXECUTE FUNCTION core.history_receiving_proof_immutable();

-- Work readiness and Auth's committed copy proof are dependency changes, not timer guesses.
CREATE FUNCTION core.history_work_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; k bytea;
BEGIN
 IF (OLD.owner_ready,OLD.absence_verified) IS NOT DISTINCT FROM (NEW.owner_ready,NEW.absence_verified) THEN RETURN NEW; END IF;
 k:=decode('0103','hex') || convert_to(NEW.work_id::text,'UTF8');
 FOR r IN SELECT account_route,account_id FROM core.history_locator
   WHERE partition_no=NEW.partition_no AND artifact_type='durable-work/v1' AND locator=k
   ORDER BY account_route,account_id LIMIT 64
 LOOP PERFORM core.history_wake_account(r.account_route,r.account_id); END LOOP;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_work_changed AFTER UPDATE OF owner_ready,absence_verified ON core.history_work
 FOR EACH ROW EXECUTE FUNCTION core.history_work_changed();
CREATE FUNCTION core.history_auth_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.phase='copies-erased' THEN PERFORM core.history_wake_account(NEW.route,NEW.account_id); END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_auth_changed AFTER INSERT ON access.auth_history_proof
 FOR EACH ROW EXECUTE FUNCTION core.history_auth_changed();

-- A native marker is permanent even after the SDK's deduplication rows disappear.
CREATE FUNCTION core.history_payload_irreversible() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='receipt' THEN
   IF OLD.payload_state='minimized' AND (NEW.payload_state<>'minimized' OR NEW.response<>'null'::jsonb) THEN
     RAISE EXCEPTION 'minimized history payload is sealed' USING ERRCODE='23514';
   END IF;
 ELSE
   IF OLD.payload_state='minimized' AND
     (NEW.payload_state<>'minimized' OR NEW.data<>'{}'::jsonb OR NEW.subject IS NOT NULL) THEN
     RAISE EXCEPTION 'minimized history payload is sealed' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_receipt_irreversible BEFORE UPDATE ON core.receipt
 FOR EACH ROW EXECUTE FUNCTION core.history_payload_irreversible();
CREATE TRIGGER history_outbox_irreversible BEFORE UPDATE ON core.outbox
 FOR EACH ROW EXECUTE FUNCTION core.history_payload_irreversible();
CREATE FUNCTION core.history_retirement_irreversible() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='retired' AND (NEW.state<>'retired' OR NEW.request IS NOT NULL OR NEW.scope IS NOT NULL
   OR NEW.request_digest<>OLD.request_digest OR NEW.owner IS DISTINCT FROM OLD.owner
   OR (OLD.absence_verified AND NOT NEW.absence_verified)) THEN
   RAISE EXCEPTION 'retired history work is sealed' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_retirement_irreversible BEFORE UPDATE ON core.history_work
 FOR EACH ROW EXECUTE FUNCTION core.history_retirement_irreversible();

-- Resource-led ownership, independent of the existing account-role union and its barrier proofs.
-- A converted command proves only its own copies. No historical completeness is inferred.
CREATE TABLE core.record_history_locator (
  source_key text COLLATE "C" NOT NULL CHECK(octet_length(source_key) BETWEEN 1 AND 256),
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  artifact_type text COLLATE "C" NOT NULL CHECK(artifact_type IN ('command-receipt/v1','outbox-event/v1','durable-work/v1')),
  locator bytea NOT NULL CHECK(octet_length(locator) BETWEEN 1 AND 256),
  original_transaction uuid NOT NULL,
  original_position bigint CHECK(original_position>=0),
  producer_version integer NOT NULL CHECK(producer_version=1),
  coverage text NOT NULL DEFAULT 'partial' CHECK(coverage='partial'),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','minimized')),
  next_attempt timestamptz NOT NULL DEFAULT now(),
  gap text CHECK(octet_length(gap)<=256),
  PRIMARY KEY(source_key,partition_no,artifact_type,locator)
);
CREATE INDEX record_history_copy ON core.record_history_locator(partition_no,artifact_type,locator,source_key);
CREATE INDEX record_history_original ON core.record_history_locator(partition_no,original_transaction)
  WHERE original_position IS NULL;
CREATE INDEX record_history_pending ON core.record_history_locator(source_key,next_attempt,partition_no,artifact_type,locator)
  WHERE state='pending';
CREATE FUNCTION core.record_history_preserve_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'record history association is immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.source_key,NEW.partition_no,NEW.artifact_type,NEW.locator,NEW.original_transaction,NEW.producer_version,NEW.coverage)
   IS DISTINCT FROM
   (OLD.source_key,OLD.partition_no,OLD.artifact_type,OLD.locator,OLD.original_transaction,OLD.producer_version,OLD.coverage)
   OR (OLD.original_position IS NOT NULL AND NEW.original_position IS DISTINCT FROM OLD.original_position)
   OR (OLD.state='minimized' AND NEW.state<>'minimized') THEN
   RAISE EXCEPTION 'record history association is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER record_history_preserve_copy BEFORE UPDATE OR DELETE ON core.record_history_locator
 FOR EACH ROW EXECUTE FUNCTION core.record_history_preserve_copy();

-- Native restart locator only, never an authority, source JSON snapshot, actor or account barrier.
CREATE TABLE core.record_history_purge (
  source_key text COLLATE "C" NOT NULL,
  deletion_generation uuid NOT NULL,
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  subject_id uuid NOT NULL, candidate_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0),
  document_id uuid,
  gap text NOT NULL DEFAULT 'record-original-producer-coverage-unsealed' CHECK(octet_length(gap)<=256),
  next_run timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_key,deletion_generation)
);
CREATE INDEX record_history_purge_runnable ON core.record_history_purge(next_run,source_key,deletion_generation);

-- Native selected-family coverage.
-- One local physical database domain. Routing/restore and definition changes serialize with
-- final verification. Remote databases cannot be represented by this local certificate.
CREATE TABLE core.history_family_domain (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  generation bigint NOT NULL DEFAULT 1 CHECK(generation>0)
);
INSERT INTO core.history_family_domain(singleton) VALUES(true);
CREATE TABLE core.history_family_definition (
  family text PRIMARY KEY CHECK(family IN ('access','commerce','community','content','library','rating','semantic','zones','imports')),
  version integer NOT NULL CHECK(version>0),
  digest text NOT NULL CHECK(digest ~ '^[0-9a-f]{64}$'),
  registry_digest text NOT NULL CHECK(registry_digest ~ '^[0-9a-f]{64}$'),
  sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='array' AND jsonb_array_length(sources) BETWEEN 1 AND 100),
  admit_cursor uuid,
  admission_complete boolean NOT NULL DEFAULT false
);
CREATE TABLE core.history_family_fence (
  account_route integer NOT NULL, account_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  PRIMARY KEY(account_route,account_id),
  FOREIGN KEY(account_route,account_id) REFERENCES access.erasure(route,account_id)
);
-- The producer owner supplies these from its actual immutable historical source inventory,
-- after enrolling all original/receiving roles and fencing its late writers. A registry entry,
-- a terminal Source page, and a participant ACK cannot insert these on the owner's behalf.
CREATE TABLE core.history_family_enrollment (
  family text NOT NULL REFERENCES core.history_family_definition(family),
  account_route integer NOT NULL, account_id uuid NOT NULL,
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  artifact_type text COLLATE "C" NOT NULL CHECK(artifact_type IN ('command-receipt/v1','outbox-event/v1','durable-work/v1')),
  producer text NOT NULL CHECK(producer ~ '^[a-z][a-z0-9_.-]{0,95}$'),
  producer_version integer NOT NULL CHECK(producer_version>0),
  definition_digest text NOT NULL CHECK(definition_digest ~ '^[0-9a-f]{64}$'),
  barrier_version integer NOT NULL CHECK(barrier_version>0), barrier_at text NOT NULL,
  partition_epoch integer NOT NULL CHECK(partition_epoch>0),
  source_cut bytea NOT NULL CHECK(octet_length(source_cut) BETWEEN 1 AND 256),
  PRIMARY KEY(family,account_route,account_id,partition_no,artifact_type,producer),
  FOREIGN KEY(account_route,account_id) REFERENCES access.erasure(route,account_id),
  FOREIGN KEY(partition_no,account_route,account_id)
    REFERENCES core.history_seal(partition_no,account_route,account_id)
);
CREATE TABLE core.history_family_coverage (
  family text NOT NULL REFERENCES core.history_family_definition(family),
  account_route integer NOT NULL, account_id uuid NOT NULL,
  barrier_version integer NOT NULL CHECK(barrier_version>0), barrier_at text NOT NULL,
  definition_digest text NOT NULL, domain_generation bigint NOT NULL, fence_revision bigint NOT NULL,
  partition_cursor integer NOT NULL DEFAULT -1 CHECK(partition_cursor BETWEEN -1 AND 4095),
  current_partition integer CHECK(current_partition BETWEEN 0 AND 4095),
  artifact_type text COLLATE "C", locator bytea CHECK(octet_length(locator) BETWEEN 1 AND 256),
  phase text NOT NULL DEFAULT 'scan' CHECK(phase IN ('scan','pending','complete')),
  gap text CHECK(octet_length(gap)<=256),
  proof_id uuid,
  next_run timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(family,account_route,account_id),
  FOREIGN KEY(account_route,account_id) REFERENCES access.erasure(route,account_id),
  CHECK((artifact_type IS NULL)=(locator IS NULL)),
  CHECK((phase='complete')=(proof_id IS NOT NULL)),
  CHECK((phase='pending')=(gap IS NOT NULL))
);
CREATE INDEX history_family_runnable ON core.history_family_coverage(next_run,family,account_route,account_id)
  WHERE phase='scan';
-- Exact physical key watches are installed under the physical source's SHARE lock. They contain
-- opaque native keys only, never payloads. A changed physical source invalidates its role union.
CREATE TABLE core.history_family_watch (
  partition_no integer NOT NULL, artifact_type text COLLATE "C" NOT NULL, locator bytea NOT NULL,
  source_key jsonb NOT NULL CHECK(octet_length(source_key::text)<=1024),
  PRIMARY KEY(partition_no,artifact_type,locator)
);
CREATE UNIQUE INDEX history_family_watch_source ON core.history_family_watch(partition_no,artifact_type,source_key);
CREATE INDEX history_locator_family_page ON core.history_locator(partition_no,account_route,account_id,artifact_type,locator);
CREATE FUNCTION core.history_family_domain_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_LEVEL='ROW' AND TG_OP='UPDATE' THEN
  IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
 END IF;
 UPDATE core.history_family_domain SET generation=generation+1 WHERE singleton;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_route_changed AFTER INSERT OR UPDATE OF node,write_state,moved_to,epoch OR DELETE ON core.partition
 FOR EACH STATEMENT EXECUTE FUNCTION core.history_family_domain_changed();
CREATE TRIGGER history_family_definition_changed AFTER INSERT OR UPDATE OF version,digest,sources,registry_digest OR DELETE ON core.history_family_definition
 FOR EACH ROW EXECUTE FUNCTION core.history_family_domain_changed();
CREATE TRIGGER history_family_registry_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_registry
 FOR EACH ROW EXECUTE FUNCTION core.history_family_domain_changed();
CREATE FUNCTION core.history_family_touch(p_route integer,p_account uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 -- Before erasure there is no issuer or aggregate to invalidate.
 IF EXISTS(SELECT 1 FROM access.erasure WHERE route=p_route AND account_id=p_account) THEN
  INSERT INTO core.history_family_fence(account_route,account_id) VALUES(p_route,p_account)
   ON CONFLICT(account_route,account_id) DO UPDATE SET revision=core.history_family_fence.revision+1;
  UPDATE core.history_family_coverage SET phase='scan',gap=NULL,proof_id=NULL,next_run=now()
   WHERE account_route=p_route AND account_id=p_account;
 END IF;
END; $$;
CREATE FUNCTION core.history_family_touch_artifact(p_partition integer,p_type text,p_locator bytea) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; n integer:=0;
BEGIN
 FOR r IN SELECT account_route,account_id FROM core.history_locator
  WHERE partition_no=p_partition AND artifact_type=p_type AND locator=p_locator
  ORDER BY account_route,account_id LIMIT 65
 LOOP
  n:=n+1;
  IF n>64 THEN RAISE EXCEPTION 'history role union exceeds native bound' USING ERRCODE='23514'; END IF;
  PERFORM core.history_family_touch(r.account_route,r.account_id);
 END LOOP;
END; $$;
CREATE FUNCTION core.history_family_scope_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN PERFORM core.history_family_touch(OLD.account_route,OLD.account_id); END IF;
 IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (NEW.account_route,NEW.account_id) IS DISTINCT FROM (OLD.account_route,OLD.account_id)) THEN
  PERFORM core.history_family_touch(NEW.account_route,NEW.account_id);
 END IF;
 IF TG_TABLE_NAME IN ('history_locator','history_receiving_proof') THEN
  IF TG_OP<>'INSERT' THEN
   PERFORM core.history_family_touch_artifact(OLD.partition_no,OLD.artifact_type,OLD.locator);
  END IF;
  IF TG_OP<>'DELETE' THEN
   PERFORM core.history_family_touch_artifact(NEW.partition_no,NEW.artifact_type,NEW.locator);
  END IF;
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_locator_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_locator
 FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();
CREATE TRIGGER history_family_receiving_changed AFTER INSERT ON core.history_receiving_proof
 FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();
CREATE TRIGGER history_family_enrollment_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_family_enrollment
 FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();
CREATE TRIGGER history_family_seal_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_seal
 FOR EACH ROW EXECUTE FUNCTION core.history_family_scope_changed();
CREATE FUNCTION core.history_family_physical_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k jsonb; t text; r record;
BEGIN
 IF TG_TABLE_NAME='receipt' THEN
  t:='command-receipt/v1'; k:=jsonb_build_array(OLD.principal_kind,OLD.principal_id,OLD.command_kind,OLD.idempotency_key);
 ELSIF TG_TABLE_NAME='outbox' THEN
  t:='outbox-event/v1'; k:=jsonb_build_array(OLD.position::text,OLD.event_seq);
 ELSE
  t:='durable-work/v1'; k:=jsonb_build_array(OLD.work_id);
 END IF;
 FOR r IN SELECT l.account_route,l.account_id FROM core.history_family_watch w
   JOIN core.history_locator l USING(partition_no,artifact_type,locator)
   WHERE w.partition_no=OLD.partition_no AND w.artifact_type=t AND w.source_key=k
   ORDER BY l.account_route,l.account_id LIMIT 65
 LOOP PERFORM core.history_family_touch(r.account_route,r.account_id); END LOOP;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_receipt_changed AFTER UPDATE OR DELETE ON core.receipt
 FOR EACH ROW EXECUTE FUNCTION core.history_family_physical_changed();
CREATE TRIGGER history_family_outbox_changed AFTER UPDATE OR DELETE ON core.outbox
 FOR EACH ROW EXECUTE FUNCTION core.history_family_physical_changed();
CREATE TRIGGER history_family_work_changed AFTER UPDATE OR DELETE ON core.history_work
 FOR EACH ROW EXECUTE FUNCTION core.history_family_physical_changed();
CREATE FUNCTION core.history_family_consumer_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p integer; k bytea;
BEGIN
 IF TG_OP='DELETE' THEN
  p:=OLD.partition_no; k:=decode('0102','hex')||int2send(p::smallint)||int8send(OLD.position)||int2send(OLD.event_seq::smallint);
 ELSE
  p:=NEW.partition_no; k:=decode('0102','hex')||int2send(p::smallint)||int8send(NEW.position)||int2send(NEW.event_seq::smallint);
 END IF;
 FOR r IN SELECT account_route,account_id FROM core.history_locator
  WHERE partition_no=p AND artifact_type='outbox-event/v1' AND locator=k
  ORDER BY account_route,account_id LIMIT 65
 LOOP PERFORM core.history_family_touch(r.account_route,r.account_id); END LOOP;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_consumer_changed AFTER INSERT OR UPDATE OR DELETE ON core.history_event_consumer
 FOR EACH ROW EXECUTE FUNCTION core.history_family_consumer_changed();
-- Enrollment is replaceable only by invalidating the account fence. The worker still checks
-- every version, original root and native seal; no source marker directly issues a capability.
CREATE TRIGGER history_family_watch_immutable BEFORE UPDATE OR DELETE ON core.history_family_watch
 FOR EACH ROW EXECUTE FUNCTION core.history_receiving_proof_immutable();
CREATE INDEX history_family_stale ON core.history_family_coverage(domain_generation,family,account_route,account_id) WHERE phase<>'scan';
CREATE FUNCTION core.history_family_validate_enrollment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e record; s record; d record; h record;
BEGIN
 SELECT version,at::text INTO STRICT e FROM access.erasure
  WHERE route=NEW.account_route AND account_id=NEW.account_id FOR SHARE;
 SELECT phase,barrier_id INTO STRICT s FROM core.history_seal WHERE partition_no=NEW.partition_no
  AND account_route=NEW.account_route AND account_id=NEW.account_id FOR SHARE;
 SELECT digest,sources INTO STRICT d FROM core.history_family_definition WHERE family=NEW.family FOR SHARE;
 SELECT epoch,write_state INTO STRICT h FROM core.partition WHERE partition_no=NEW.partition_no FOR SHARE;
 IF h.epoch<>NEW.partition_epoch OR h.write_state<>'active' OR e.version<>NEW.barrier_version OR e.at<>NEW.barrier_at OR s.phase='open' OR s.barrier_id<>NEW.account_id
   OR d.digest<>NEW.definition_digest OR NOT EXISTS(
     SELECT 1 FROM jsonb_to_recordset(d.sources) AS p("artifactType" text,producer text,version integer)
     WHERE p."artifactType"=NEW.artifact_type AND p.producer=NEW.producer AND p.version=NEW.producer_version)
 THEN RAISE EXCEPTION 'history family enrollment does not match native source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_family_validate_enrollment BEFORE INSERT OR UPDATE ON core.history_family_enrollment
 FOR EACH ROW EXECUTE FUNCTION core.history_family_validate_enrollment();
CREATE FUNCTION core.history_family_preserve_locator() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sealed boolean;
BEGIN
 SELECT phase<>'open' INTO sealed FROM core.history_seal WHERE partition_no=OLD.partition_no
  AND account_route=OLD.account_route AND account_id=OLD.account_id FOR SHARE;
 IF TG_OP='DELETE' THEN
  IF sealed OR OLD.state='minimized' THEN
   RAISE EXCEPTION 'sealed history role is irreversible' USING ERRCODE='23514';
  END IF;
  RETURN OLD;
 END IF;
 IF (sealed AND (OLD.partition_no,OLD.account_route,OLD.account_id,OLD.artifact_type,OLD.locator,OLD.roles,OLD.minimizer_version)
   IS DISTINCT FROM (NEW.partition_no,NEW.account_route,NEW.account_id,NEW.artifact_type,NEW.locator,NEW.roles,NEW.minimizer_version))
   OR (OLD.state='minimized' AND (NEW.state<>'minimized' OR NEW.proof_barrier IS DISTINCT FROM OLD.proof_barrier))
 THEN RAISE EXCEPTION 'sealed history role is irreversible' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER history_family_preserve_locator BEFORE UPDATE OR DELETE ON core.history_locator
 FOR EACH ROW EXECUTE FUNCTION core.history_family_preserve_locator();
CREATE FUNCTION core.history_family_admit(p_family text,p_route integer,p_account uuid) RETURNS void LANGUAGE sql AS $$
 INSERT INTO core.history_family_fence(account_route,account_id) VALUES(p_route,p_account) ON CONFLICT DO NOTHING;
 INSERT INTO core.history_family_coverage(family,account_route,account_id,barrier_version,barrier_at,
   definition_digest,domain_generation,fence_revision)
 SELECT p_family,e.route,e.account_id,e.version,e.at::text,d.digest,g.generation,f.revision
 FROM access.erasure e,core.history_family_definition d,core.history_family_domain g,core.history_family_fence f
 WHERE e.route=p_route AND e.account_id=p_account AND d.family=p_family AND g.singleton
  AND f.account_route=e.route AND f.account_id=e.account_id ON CONFLICT DO NOTHING;
$$;
CREATE FUNCTION core.history_family_job_admitted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d record;
BEGIN
 FOR d IN SELECT family FROM core.history_family_definition ORDER BY family LIMIT 9
 LOOP PERFORM core.history_family_admit(d.family,NEW.account_route,NEW.account_id); END LOOP;
 RETURN NULL;
END; $$;
CREATE TRIGGER history_family_job_admitted AFTER INSERT ON core.preference_history_job
 FOR EACH ROW EXECUTE FUNCTION core.history_family_job_admitted();
