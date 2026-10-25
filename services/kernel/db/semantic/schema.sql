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
-- Name: semantic; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA semantic;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: context; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.context (
    route integer NOT NULL,
    context_id uuid NOT NULL,
    kind text NOT NULL,
    labels jsonb NOT NULL,
    recorded_transaction_id uuid,
    CONSTRAINT context_check CHECK ((route = ((get_byte(uuid_send(context_id), 10) * 256) + get_byte(uuid_send(context_id), 11)))),
    CONSTRAINT context_kind_check CHECK ((kind = ANY (ARRAY['global'::text, 'community'::text]))),
    CONSTRAINT context_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: definition_activation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_activation (
    route integer NOT NULL,
    head integer NOT NULL,
    digest text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT definition_activation_head_check CHECK ((head >= 1)),
    CONSTRAINT definition_activation_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: definition_release; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.definition_release (
    route integer NOT NULL,
    digest text NOT NULL,
    body jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT definition_release_digest_check CHECK ((digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT definition_release_route_check CHECK (((route >= 0) AND (route <= 65535)))
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
-- Name: context context_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context
    ADD CONSTRAINT context_pkey PRIMARY KEY (route, context_id);


--
-- Name: definition_activation definition_activation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_activation
    ADD CONSTRAINT definition_activation_pkey PRIMARY KEY (route, head);


--
-- Name: definition_release definition_release_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_release
    ADD CONSTRAINT definition_release_pkey PRIMARY KEY (route, digest);


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
-- Name: definition_activation definition_activation_route_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.definition_activation
    ADD CONSTRAINT definition_activation_route_digest_fkey FOREIGN KEY (route, digest) REFERENCES semantic.definition_release(route, digest);


--
-- Name: fact fact_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.fact
    ADD CONSTRAINT fact_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- PostgreSQL database dump complete
--


