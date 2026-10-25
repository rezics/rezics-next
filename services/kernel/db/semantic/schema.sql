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


--
-- Name: prevent_revision_mutation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prevent_revision_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'Semantic revisions are immutable' USING ERRCODE = '23514'; END; $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: acceptance; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.acceptance (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    context_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    head integer NOT NULL,
    verdict text NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT acceptance_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT acceptance_head_check CHECK ((head >= 1)),
    CONSTRAINT acceptance_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT acceptance_verdict_check CHECK ((verdict = ANY (ARRAY['accept'::text, 'reject'::text, 'abstain'::text])))
);


--
-- Name: acceptance_current; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.acceptance_current (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    context_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    head integer NOT NULL,
    verdict text NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT acceptance_current_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT acceptance_current_head_check CHECK ((head >= 1)),
    CONSTRAINT acceptance_current_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT acceptance_current_verdict_check CHECK ((verdict = ANY (ARRAY['accept'::text, 'reject'::text, 'abstain'::text])))
);


--
-- Name: adoption; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.adoption (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    context_id uuid NOT NULL,
    head integer NOT NULL,
    mode text NOT NULL,
    selection jsonb NOT NULL,
    revision integer NOT NULL,
    CONSTRAINT adoption_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT adoption_head_check CHECK ((head >= 1)),
    CONSTRAINT adoption_mode_check CHECK ((mode = ANY (ARRAY['inherit'::text, 'replace'::text, 'suppress'::text]))),
    CONSTRAINT adoption_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT adoption_selection_check CHECK ((jsonb_typeof(selection) = 'array'::text)),
    CONSTRAINT adoption_selection_check1 CHECK ((jsonb_array_length(selection) <= 32)),
    CONSTRAINT adoption_selection_check2 CHECK ((NOT jsonb_path_exists(selection, '$[*]?(@."candidate".type() != "string" || @."rank" != "normal" && @."rank" != "preferred")'::jsonpath))),
    CONSTRAINT adoption_selection_check3 CHECK ((NOT jsonb_path_exists(selection, '$[*]?(!(exists (@."candidate")) || !(exists (@."rank")))'::jsonpath))),
    CONSTRAINT adoption_selection_objects_check CHECK ((NOT jsonb_path_exists(selection, 'strict $[*]?(@.type() != "object")'::jsonpath)))
);


--
-- Name: candidate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.candidate (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    property text NOT NULL,
    rank text NOT NULL,
    statement jsonb NOT NULL,
    release text NOT NULL,
    revision integer NOT NULL,
    origin text NOT NULL,
    view_order integer DEFAULT 0 NOT NULL,
    CONSTRAINT candidate_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT candidate_check1 CHECK ((route = ((get_byte(uuid_send(candidate_id), 10) * 256) + get_byte(uuid_send(candidate_id), 11)))),
    CONSTRAINT candidate_origin_check CHECK ((origin = ANY (ARRAY['compact'::text, 'proposal'::text]))),
    CONSTRAINT candidate_rank_check CHECK ((rank = ANY (ARRAY['normal'::text, 'preferred'::text]))),
    CONSTRAINT candidate_release_check CHECK ((release ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT candidate_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT candidate_statement_check CHECK ((jsonb_typeof(statement) = 'object'::text)),
    CONSTRAINT candidate_view_order_check CHECK (((view_order >= 0) AND (view_order <= 32)))
);


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
    CONSTRAINT fact_check CHECK ((((operation = 'expand'::text) AND (kind = 'statement'::text) AND (language IS NULL) AND (property IS NOT NULL) AND (statement_id IS NULL) AND (body = '{}'::jsonb)) OR ((operation <> 'expand'::text) AND (((kind = ANY (ARRAY['label'::text, 'description'::text, 'alias'::text])) AND (language IS NOT NULL) AND (property IS NULL) AND (statement_id IS NULL)) OR ((kind = 'statement'::text) AND (language IS NULL) AND (property IS NOT NULL) AND (statement_id IS NOT NULL)))))),
    CONSTRAINT fact_kind_check CHECK ((kind = ANY (ARRAY['label'::text, 'description'::text, 'alias'::text, 'statement'::text]))),
    CONSTRAINT fact_log_seq_check CHECK ((((log_seq >= 1) AND (log_seq <= 33)) AND ((log_seq <> 33) OR (operation = 'expand'::text)))),
    CONSTRAINT fact_operation_check CHECK ((operation = ANY (ARRAY['assert'::text, 'retract'::text, 'expand'::text]))),
    CONSTRAINT fact_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11))))
);


--
-- Name: revision; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.revision (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    revision integer NOT NULL,
    kind text NOT NULL,
    release text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT revision_kind_check CHECK ((kind = ANY (ARRAY['create'::text, 'propose'::text, 'accept'::text, 'reject'::text, 'adopt'::text, 'merge'::text]))),
    CONSTRAINT revision_release_check CHECK ((release ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT revision_revision_check CHECK ((revision >= 1)),
    CONSTRAINT revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT revision_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11))))
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
    CONSTRAINT subject_type_check CHECK ((type ~ '^[a-z][a-z0-9_]*:[A-Za-z][A-Za-z0-9_]*$'::text))
);


--
-- Name: acceptance_current acceptance_current_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance_current
    ADD CONSTRAINT acceptance_current_pkey PRIMARY KEY (route, subject_id, context_id, candidate_id);


--
-- Name: acceptance acceptance_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance
    ADD CONSTRAINT acceptance_pkey PRIMARY KEY (route, subject_id, context_id, candidate_id, head);


--
-- Name: adoption adoption_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.adoption
    ADD CONSTRAINT adoption_pkey PRIMARY KEY (route, subject_id, slot_id, context_id, head);


--
-- Name: candidate candidate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.candidate
    ADD CONSTRAINT candidate_pkey PRIMARY KEY (route, subject_id, candidate_id);


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
-- Name: revision revision_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.revision
    ADD CONSTRAINT revision_pkey PRIMARY KEY (route, subject_id, revision);


--
-- Name: subject subject_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.subject
    ADD CONSTRAINT subject_pkey PRIMARY KEY (route, subject_id);


--
-- Name: acceptance_current_rejected; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX acceptance_current_rejected ON semantic.acceptance_current USING btree (route, subject_id, context_id, slot_id, revision DESC, candidate_id) WHERE (verdict = 'reject'::text);


--
-- Name: candidate_page; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX candidate_page ON semantic.candidate USING btree (route, subject_id, slot_id, revision, view_order, candidate_id);


--
-- Name: fact_compact_candidate; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_compact_candidate ON semantic.fact USING btree (route, subject_id, statement_id, log_seq DESC) WHERE ((kind = 'statement'::text) AND (operation = 'assert'::text) AND (statement_id IS NOT NULL));


--
-- Name: fact_terms; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_terms ON semantic.fact USING btree (route, subject_id, slot_id, log_seq) WHERE (kind <> 'statement'::text);


--
-- Name: revision_transaction; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX revision_transaction ON semantic.revision USING btree (route, subject_id, recorded_transaction_id);


--
-- Name: acceptance acceptance_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER acceptance_immutable BEFORE DELETE OR UPDATE ON semantic.acceptance FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: acceptance acceptance_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER acceptance_immutable_truncate BEFORE TRUNCATE ON semantic.acceptance FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: adoption adoption_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER adoption_immutable BEFORE DELETE OR UPDATE ON semantic.adoption FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: adoption adoption_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER adoption_immutable_truncate BEFORE TRUNCATE ON semantic.adoption FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: candidate candidate_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER candidate_immutable BEFORE DELETE OR UPDATE ON semantic.candidate FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: candidate candidate_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER candidate_immutable_truncate BEFORE TRUNCATE ON semantic.candidate FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: fact fact_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER fact_immutable BEFORE DELETE OR UPDATE ON semantic.fact FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: fact fact_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER fact_immutable_truncate BEFORE TRUNCATE ON semantic.fact FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: revision revision_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER revision_immutable BEFORE DELETE OR UPDATE ON semantic.revision FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: revision revision_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER revision_immutable_truncate BEFORE TRUNCATE ON semantic.revision FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: acceptance_current acceptance_current_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance_current
    ADD CONSTRAINT acceptance_current_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: acceptance_current acceptance_current_route_subject_id_context_id_candidate_i_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance_current
    ADD CONSTRAINT acceptance_current_route_subject_id_context_id_candidate_i_fkey FOREIGN KEY (route, subject_id, context_id, candidate_id, head) REFERENCES semantic.acceptance(route, subject_id, context_id, candidate_id, head);


--
-- Name: acceptance_current acceptance_current_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance_current
    ADD CONSTRAINT acceptance_current_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: acceptance acceptance_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance
    ADD CONSTRAINT acceptance_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: acceptance acceptance_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance
    ADD CONSTRAINT acceptance_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: acceptance acceptance_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.acceptance
    ADD CONSTRAINT acceptance_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: adoption adoption_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.adoption
    ADD CONSTRAINT adoption_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: adoption adoption_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.adoption
    ADD CONSTRAINT adoption_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: candidate candidate_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.candidate
    ADD CONSTRAINT candidate_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: candidate candidate_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.candidate
    ADD CONSTRAINT candidate_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


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
-- Name: revision revision_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.revision
    ADD CONSTRAINT revision_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- PostgreSQL database dump complete
--


