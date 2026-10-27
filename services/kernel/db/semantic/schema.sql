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
-- Name: guard_subject_security(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.guard_subject_security() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.security_revision < OLD.security_revision
     OR (NEW.visibility IS DISTINCT FROM OLD.visibility AND NEW.security_revision <= OLD.security_revision) THEN
    RAISE EXCEPTION 'Visibility changes require an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: prevent_fact_mutation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prevent_fact_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Only the derived account node's display label is erasable personal data.
  IF TG_OP = 'DELETE' AND OLD.kind = 'label' AND EXISTS (
    SELECT 1 FROM semantic.account_agent_subject account
    WHERE account.agent_id = OLD.subject_id AND account.account_route = OLD.route
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Semantic revisions are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: prevent_moderation_mutation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prevent_moderation_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'Semantic moderation records are immutable' USING ERRCODE = '23514'; END; $$;


--
-- Name: prevent_redirect_mutation(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.prevent_redirect_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1
      FROM semantic.revision AS revision
      WHERE revision.route = OLD.route AND revision.subject_id = OLD.subject_id
        AND revision.revision = (
          SELECT max(latest.revision)
          FROM semantic.revision AS latest
          WHERE latest.route = OLD.route AND latest.subject_id = OLD.subject_id
        )
        AND revision.revocation_receipt_id IS NOT NULL
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Semantic redirects are immutable' USING ERRCODE = '23514';
  END;
  $$;


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
-- Name: account_agent_moved_link; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.account_agent_moved_link (
    route integer NOT NULL,
    receipt_id text NOT NULL,
    account_id uuid NOT NULL,
    survivor uuid NOT NULL,
    moved_from uuid NOT NULL,
    statement_id uuid NOT NULL,
    property text NOT NULL,
    source_subject_id uuid NOT NULL,
    filter_value uuid NOT NULL,
    source_revision integer,
    source_security_revision bigint,
    present boolean,
    source_type text,
    order_key text,
    reversal_prepared boolean DEFAULT false NOT NULL,
    reversed boolean DEFAULT false NOT NULL,
    CONSTRAINT account_agent_moved_link_receipt_check CHECK (((length(receipt_id) >= 1) AND (length(receipt_id) <= 255)))
);


--
-- Name: account_agent_subject; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.account_agent_subject (
    route integer NOT NULL,
    account_route integer NOT NULL,
    subject_id uuid NOT NULL,
    account_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    receipt_id text,
    CONSTRAINT account_agent_subject_account_route_check CHECK ((account_route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_agent_subject_receipt_check CHECK (((verified AND (receipt_id IS NOT NULL) AND ((length(receipt_id) >= 1) AND (length(receipt_id) <= 255))) OR ((NOT verified) AND (receipt_id IS NULL)))),
    CONSTRAINT account_agent_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11))))
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
    relation boolean DEFAULT false NOT NULL,
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
    settings_id text,
    settings_release text,
    defaults jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT context_check CHECK ((route = ((get_byte(uuid_send(context_id), 10) * 256) + get_byte(uuid_send(context_id), 11)))),
    CONSTRAINT context_defaults_check CHECK (((jsonb_typeof(defaults) = 'object'::text) AND (NOT jsonb_path_exists(defaults, '$.*?(@ != "inherit" && @ != "suppress")'::jsonpath)))),
    CONSTRAINT context_kind_check CHECK ((kind = ANY (ARRAY['global'::text, 'community'::text]))),
    CONSTRAINT context_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT context_settings_id_check CHECK (((settings_id IS NULL) OR (settings_id ~ '^[a-z][a-z0-9-]{0,63}$'::text))),
    CONSTRAINT context_settings_pair_check CHECK (((settings_id IS NULL) = (settings_release IS NULL))),
    CONSTRAINT context_settings_release_check CHECK (((settings_release IS NULL) OR (settings_release ~ '^sha256:[0-9a-f]{64}$'::text))),
    CONSTRAINT context_without_settings_defaults_check CHECK (((settings_id IS NOT NULL) OR (defaults = '{}'::jsonb)))
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
-- Name: external_claim; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.external_claim (
    route integer NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    subject_id uuid NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT external_claim_route_check CHECK (((route >= 0) AND (route <= 65535)))
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
    release text,
    relation boolean DEFAULT false NOT NULL,
    CONSTRAINT fact_check CHECK ((((operation = 'expand'::text) AND (kind = 'statement'::text) AND (language IS NULL) AND (property IS NOT NULL) AND (statement_id IS NULL) AND (body = '{}'::jsonb)) OR ((operation <> 'expand'::text) AND (((kind = ANY (ARRAY['label'::text, 'description'::text, 'alias'::text])) AND (language IS NOT NULL) AND (property IS NULL) AND (statement_id IS NULL)) OR ((kind = 'statement'::text) AND (language IS NULL) AND (property IS NOT NULL) AND (statement_id IS NOT NULL)))))),
    CONSTRAINT fact_kind_check CHECK ((kind = ANY (ARRAY['label'::text, 'description'::text, 'alias'::text, 'statement'::text]))),
    CONSTRAINT fact_log_seq_check CHECK ((((log_seq >= 1) AND (log_seq <= 33)) AND ((log_seq <> 33) OR (operation = 'expand'::text)))),
    CONSTRAINT fact_operation_check CHECK ((operation = ANY (ARRAY['assert'::text, 'retract'::text, 'expand'::text]))),
    CONSTRAINT fact_release_check CHECK ((((kind = 'statement'::text) AND (operation = 'assert'::text)) = (release IS NOT NULL))),
    CONSTRAINT fact_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11))))
);


--
-- Name: hidden_candidate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.hidden_candidate (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    visibility text NOT NULL,
    security_revision bigint NOT NULL,
    CONSTRAINT hidden_candidate_candidate_route_check CHECK ((route = ((get_byte(uuid_send(candidate_id), 10) * 256) + get_byte(uuid_send(candidate_id), 11)))),
    CONSTRAINT hidden_candidate_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT hidden_candidate_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT hidden_candidate_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT hidden_candidate_visibility_check CHECK ((visibility = ANY (ARRAY['hidden'::text, 'taken_down'::text])))
);


--
-- Name: inbound_link; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.inbound_link (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    property text NOT NULL,
    source_subject_id uuid NOT NULL,
    statement_id uuid NOT NULL,
    source_revision integer NOT NULL,
    present boolean NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    source_security_revision bigint DEFAULT 0 NOT NULL,
    source_type text DEFAULT ''::text NOT NULL,
    order_key text DEFAULT ''::text NOT NULL COLLATE pg_catalog."C",
    filter_value uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
    suppressed boolean DEFAULT false NOT NULL,
    CONSTRAINT inbound_link_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT inbound_link_property_check CHECK ((char_length(property) >= 1)),
    CONSTRAINT inbound_link_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT inbound_link_source_revision_check CHECK ((source_revision >= 1)),
    CONSTRAINT inbound_link_source_security_revision_check CHECK ((source_security_revision >= 0))
);


--
-- Name: inbound_link_context_count; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.inbound_link_context_count (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    context_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    value bigint NOT NULL,
    CONSTRAINT inbound_link_context_count_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT inbound_link_context_count_context_id_check CHECK ((context_id <> '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT inbound_link_context_count_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: inbound_link_count; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.inbound_link_count (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    value bigint NOT NULL,
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
    CONSTRAINT inbound_link_count_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT inbound_link_count_context_id_check CHECK ((context_id = '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT inbound_link_count_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT inbound_link_count_value_check CHECK ((value >= 0))
);


--
-- Name: merge_member; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.merge_member (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    member_id uuid NOT NULL,
    phase text DEFAULT 'links'::text NOT NULL,
    cursor jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT merge_member_phase_check CHECK ((phase = ANY (ARRAY['links'::text, 'outbound'::text, 'members'::text, 'done'::text])))
);


--
-- Name: moderation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.moderation (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    security_revision bigint NOT NULL,
    action text NOT NULL,
    visibility text NOT NULL,
    actor uuid NOT NULL,
    body jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    candidate_id uuid,
    CONSTRAINT moderation_action_check CHECK ((action = ANY (ARRAY['hide'::text, 'take_down'::text, 'restore'::text]))),
    CONSTRAINT moderation_body_check CHECK ((jsonb_typeof(body) = 'object'::text)),
    CONSTRAINT moderation_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT moderation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT moderation_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT moderation_visibility_check CHECK ((visibility = ANY (ARRAY['visible'::text, 'hidden'::text, 'taken_down'::text])))
);


--
-- Name: outbound_link; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.outbound_link (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    order_key text NOT NULL COLLATE pg_catalog."C",
    target_subject_id uuid NOT NULL,
    statement_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    relation boolean NOT NULL,
    source_type text DEFAULT ''::text NOT NULL,
    source_order_key text DEFAULT ''::text NOT NULL COLLATE pg_catalog."C",
    outbound_order text,
    source_revision integer NOT NULL,
    source_security_revision bigint DEFAULT 0 NOT NULL,
    target_revision integer DEFAULT 0 NOT NULL,
    target_type text DEFAULT ''::text NOT NULL,
    external text,
    value text NOT NULL,
    present boolean NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
    suppressed boolean DEFAULT false NOT NULL,
    CONSTRAINT outbound_link_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT outbound_link_property_check CHECK ((char_length(property) >= 1)),
    CONSTRAINT outbound_link_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT outbound_link_source_revision_check CHECK ((source_revision >= 1)),
    CONSTRAINT outbound_link_source_security_revision_check CHECK ((source_security_revision >= 0)),
    CONSTRAINT outbound_link_target_revision_check CHECK ((target_revision >= 0)),
    CONSTRAINT outbound_link_value_check CHECK ((value = ANY (ARRAY['value'::text, 'somevalue'::text, 'novalue'::text])))
);


--
-- Name: outbound_link_context_count; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.outbound_link_context_count (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    context_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    value bigint NOT NULL,
    CONSTRAINT outbound_link_context_count_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT outbound_link_context_count_context_id_check CHECK ((context_id <> '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT outbound_link_context_count_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: outbound_link_count; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.outbound_link_count (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    property text NOT NULL,
    filter_value uuid NOT NULL,
    value bigint NOT NULL,
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
    CONSTRAINT outbound_link_count_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT outbound_link_count_context_id_check CHECK ((context_id = '00000000-0000-8000-8000-000000000000'::uuid)),
    CONSTRAINT outbound_link_count_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT outbound_link_count_value_check CHECK ((value >= 0))
);


--
-- Name: partition_subjects; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.partition_subjects (
    partition_no integer NOT NULL,
    visible bigint DEFAULT 0 NOT NULL,
    CONSTRAINT partition_subjects_partition_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT partition_subjects_visible_check CHECK ((visible >= 0))
);


--
-- Name: redirect; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.redirect (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    sequence integer NOT NULL,
    target uuid NOT NULL,
    recorded_transaction_id uuid NOT NULL
);


--
-- Name: relation_context_slot; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.relation_context_slot (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    slot_id uuid NOT NULL,
    context_id uuid NOT NULL,
    CONSTRAINT relation_context_slot_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT relation_context_slot_context_id_check CHECK ((context_id <> '00000000-0000-8000-8000-000000000000'::uuid))
);


--
-- Name: retraction; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.retraction (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    revision integer NOT NULL,
    "references" jsonb NOT NULL,
    CONSTRAINT retraction_references_check CHECK ((jsonb_typeof("references") = 'array'::text))
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
    source jsonb,
    verification_receipt_id text,
    revocation_receipt_id text,
    revoked_survivor_id uuid,
    CONSTRAINT revision_kind_check CHECK ((kind = ANY (ARRAY['create'::text, 'propose'::text, 'accept'::text, 'reject'::text, 'adopt'::text, 'merge'::text, 'retract'::text, 'identity'::text]))),
    CONSTRAINT revision_release_check CHECK ((release ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT revision_revision_check CHECK ((revision >= 1)),
    CONSTRAINT revision_revocation_receipt_check CHECK (((revocation_receipt_id IS NULL) OR ((length(revocation_receipt_id) >= 1) AND (length(revocation_receipt_id) <= 255)))),
    CONSTRAINT revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT revision_subject_route_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11))))
);


--
-- Name: source_candidate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.source_candidate (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    field_group text NOT NULL,
    statement_digest text NOT NULL,
    candidate_id uuid NOT NULL,
    CONSTRAINT source_candidate_statement_digest_check CHECK ((statement_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: statement_disclosure; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.statement_disclosure (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    target_id uuid NOT NULL,
    account_id uuid NOT NULL,
    property text NOT NULL,
    disclosed boolean DEFAULT false NOT NULL,
    source_order_key text NOT NULL COLLATE pg_catalog."C",
    target_order_key text NOT NULL COLLATE pg_catalog."C"
);


--
-- Name: subject; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.subject (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    type text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    visibility text DEFAULT 'visible'::text NOT NULL,
    security_revision bigint DEFAULT 0 NOT NULL,
    current_facts integer DEFAULT 0 NOT NULL,
    current_release text DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000'::text NOT NULL,
    projection_pending boolean DEFAULT false NOT NULL,
    CONSTRAINT subject_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_security_revision_check CHECK ((security_revision >= 0)),
    CONSTRAINT subject_type_check CHECK ((type ~ '^[a-z][a-z0-9_]*:[A-Za-z][A-Za-z0-9_]*$'::text)),
    CONSTRAINT subject_visibility_check CHECK ((visibility = ANY (ARRAY['visible'::text, 'hidden'::text, 'taken_down'::text])))
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
-- Name: account_agent_moved_link account_agent_moved_link_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.account_agent_moved_link
    ADD CONSTRAINT account_agent_moved_link_pkey PRIMARY KEY (route, receipt_id, moved_from, property, source_subject_id, statement_id, filter_value);


--
-- Name: account_agent_subject account_agent_subject_account_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.account_agent_subject
    ADD CONSTRAINT account_agent_subject_account_id_key UNIQUE (account_id);


--
-- Name: account_agent_subject account_agent_subject_agent_id_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.account_agent_subject
    ADD CONSTRAINT account_agent_subject_agent_id_key UNIQUE (agent_id);


--
-- Name: account_agent_subject account_agent_subject_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.account_agent_subject
    ADD CONSTRAINT account_agent_subject_pkey PRIMARY KEY (route, subject_id);


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
-- Name: external_claim external_claim_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.external_claim
    ADD CONSTRAINT external_claim_pkey PRIMARY KEY (route, source, external_id);


--
-- Name: fact fact_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.fact
    ADD CONSTRAINT fact_pkey PRIMARY KEY (route, subject_id, slot_id, log_seq);


--
-- Name: hidden_candidate hidden_candidate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.hidden_candidate
    ADD CONSTRAINT hidden_candidate_pkey PRIMARY KEY (route, subject_id, candidate_id);


--
-- Name: inbound_link_context_count inbound_link_context_count_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.inbound_link_context_count
    ADD CONSTRAINT inbound_link_context_count_pkey PRIMARY KEY (route, subject_id, context_id, property, filter_value);


--
-- Name: inbound_link_count inbound_link_count_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.inbound_link_count
    ADD CONSTRAINT inbound_link_count_pkey PRIMARY KEY (route, subject_id, property, filter_value);


--
-- Name: inbound_link inbound_link_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.inbound_link
    ADD CONSTRAINT inbound_link_pkey PRIMARY KEY (route, subject_id, context_id, property, source_subject_id, statement_id, filter_value);


--
-- Name: merge_member merge_member_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.merge_member
    ADD CONSTRAINT merge_member_pkey PRIMARY KEY (route, subject_id, member_id);


--
-- Name: moderation moderation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.moderation
    ADD CONSTRAINT moderation_pkey PRIMARY KEY (route, subject_id, security_revision);


--
-- Name: outbound_link_context_count outbound_link_context_count_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.outbound_link_context_count
    ADD CONSTRAINT outbound_link_context_count_pkey PRIMARY KEY (route, subject_id, context_id, property, filter_value);


--
-- Name: outbound_link_count outbound_link_count_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.outbound_link_count
    ADD CONSTRAINT outbound_link_count_pkey PRIMARY KEY (route, subject_id, property, filter_value);


--
-- Name: outbound_link outbound_link_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.outbound_link
    ADD CONSTRAINT outbound_link_pkey PRIMARY KEY (route, subject_id, context_id, property, filter_value, order_key, target_subject_id, statement_id);


--
-- Name: partition_subjects partition_subjects_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.partition_subjects
    ADD CONSTRAINT partition_subjects_pkey PRIMARY KEY (partition_no);


--
-- Name: redirect redirect_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.redirect
    ADD CONSTRAINT redirect_pkey PRIMARY KEY (route, subject_id, sequence);


--
-- Name: relation_context_slot relation_context_slot_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.relation_context_slot
    ADD CONSTRAINT relation_context_slot_pkey PRIMARY KEY (route, subject_id, slot_id, context_id);


--
-- Name: retraction retraction_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.retraction
    ADD CONSTRAINT retraction_pkey PRIMARY KEY (route, subject_id, candidate_id, revision);


--
-- Name: revision revision_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.revision
    ADD CONSTRAINT revision_pkey PRIMARY KEY (route, subject_id, revision);


--
-- Name: source_candidate source_candidate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.source_candidate
    ADD CONSTRAINT source_candidate_pkey PRIMARY KEY (route, subject_id, source, external_id, field_group, statement_digest);


--
-- Name: statement_disclosure statement_disclosure_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.statement_disclosure
    ADD CONSTRAINT statement_disclosure_pkey PRIMARY KEY (route, candidate_id);


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
-- Name: fact_label; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_label ON semantic.fact USING btree (route, subject_id, language) WHERE ((kind = 'label'::text) AND (operation = 'assert'::text));


--
-- Name: fact_terms; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX fact_terms ON semantic.fact USING btree (route, subject_id, slot_id, log_seq) WHERE (kind <> 'statement'::text);


--
-- Name: inbound_link_all_present; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_all_present ON semantic.inbound_link USING btree (route, subject_id, context_id, property, source_subject_id, statement_id) INCLUDE (source_type, suppressed) WHERE (present AND (filter_value = '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: inbound_link_context_overrides; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_context_overrides ON semantic.inbound_link USING btree (route, subject_id, property, filter_value, statement_id, source_subject_id, context_id) WHERE (present AND (context_id <> '00000000-0000-8000-8000-000000000000'::uuid));


--
-- Name: inbound_link_key_reemit; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_key_reemit ON semantic.inbound_link USING btree (route, subject_id, property, source_subject_id, statement_id, filter_value, context_id) WHERE present;


--
-- Name: inbound_link_present; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_present ON semantic.inbound_link USING btree (route, subject_id, context_id, property, filter_value, order_key, source_subject_id, statement_id) INCLUDE (source_type, suppressed) WHERE present;


--
-- Name: merge_member_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX merge_member_pending ON semantic.merge_member USING btree (route, subject_id, member_id) WHERE (phase <> 'done'::text);


--
-- Name: outbound_link_context_overrides; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_context_overrides ON semantic.outbound_link USING btree (route, subject_id, property, filter_value, statement_id, target_subject_id, context_id) WHERE (present AND (context_id <> '00000000-0000-8000-8000-000000000000'::uuid));


--
-- Name: outbound_link_identity; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_identity ON semantic.outbound_link USING btree (route, subject_id, context_id, property, statement_id, filter_value) WHERE present;


--
-- Name: outbound_link_key_reemit; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_key_reemit ON semantic.outbound_link USING btree (route, subject_id, property, target_subject_id, statement_id, filter_value, context_id) WHERE (present AND relation);


--
-- Name: outbound_link_maintenance; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_maintenance ON semantic.outbound_link USING btree (route, subject_id, property, target_subject_id, statement_id, filter_value, context_id) WHERE present;


--
-- Name: outbound_link_present; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_present ON semantic.outbound_link USING btree (route, subject_id, context_id, property, filter_value, order_key, target_subject_id, statement_id) INCLUDE (relation, target_type, suppressed) WHERE present;


--
-- Name: outbound_link_statement; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_statement ON semantic.outbound_link USING btree (route, subject_id, context_id, property, filter_value, statement_id, source_revision DESC, source_security_revision DESC, target_revision DESC);


--
-- Name: revision_transaction; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX revision_transaction ON semantic.revision USING btree (recorded_transaction_id, route, subject_id);


--
-- Name: source_candidate_retract; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX source_candidate_retract ON semantic.source_candidate USING btree (route, subject_id, candidate_id, source, external_id, field_group);


--
-- Name: statement_disclosure_inbound; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX statement_disclosure_inbound ON semantic.statement_disclosure USING btree (target_id, account_id, property, source_order_key, subject_id, candidate_id) WHERE (NOT disclosed);


--
-- Name: statement_disclosure_outbound; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX statement_disclosure_outbound ON semantic.statement_disclosure USING btree (subject_id, account_id, property, target_order_key, target_id, candidate_id) WHERE (NOT disclosed);


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
-- Name: external_claim external_claim_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER external_claim_immutable BEFORE DELETE OR UPDATE ON semantic.external_claim FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: external_claim external_claim_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER external_claim_immutable_truncate BEFORE TRUNCATE ON semantic.external_claim FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: fact fact_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER fact_immutable BEFORE DELETE OR UPDATE ON semantic.fact FOR EACH ROW EXECUTE FUNCTION semantic.prevent_fact_mutation();


--
-- Name: fact fact_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER fact_immutable_truncate BEFORE TRUNCATE ON semantic.fact FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: moderation moderation_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER moderation_immutable BEFORE DELETE OR UPDATE ON semantic.moderation FOR EACH ROW EXECUTE FUNCTION semantic.prevent_moderation_mutation();


--
-- Name: moderation moderation_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER moderation_immutable_truncate BEFORE TRUNCATE ON semantic.moderation FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_moderation_mutation();


--
-- Name: redirect redirect_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER redirect_immutable BEFORE DELETE OR UPDATE ON semantic.redirect FOR EACH ROW EXECUTE FUNCTION semantic.prevent_redirect_mutation();


--
-- Name: retraction retraction_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER retraction_immutable BEFORE DELETE OR UPDATE ON semantic.retraction FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: retraction retraction_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER retraction_immutable_truncate BEFORE TRUNCATE ON semantic.retraction FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: revision revision_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER revision_immutable BEFORE DELETE OR UPDATE ON semantic.revision FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: revision revision_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER revision_immutable_truncate BEFORE TRUNCATE ON semantic.revision FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: subject subject_security_revision; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER subject_security_revision BEFORE UPDATE ON semantic.subject FOR EACH ROW EXECUTE FUNCTION semantic.guard_subject_security();


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
-- Name: external_claim external_claim_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.external_claim
    ADD CONSTRAINT external_claim_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: fact fact_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.fact
    ADD CONSTRAINT fact_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: hidden_candidate hidden_candidate_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.hidden_candidate
    ADD CONSTRAINT hidden_candidate_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: merge_member merge_member_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.merge_member
    ADD CONSTRAINT merge_member_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: moderation moderation_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.moderation
    ADD CONSTRAINT moderation_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: moderation moderation_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.moderation
    ADD CONSTRAINT moderation_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: redirect redirect_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.redirect
    ADD CONSTRAINT redirect_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: retraction retraction_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.retraction
    ADD CONSTRAINT retraction_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: retraction retraction_route_subject_id_revision_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.retraction
    ADD CONSTRAINT retraction_route_subject_id_revision_fkey FOREIGN KEY (route, subject_id, revision) REFERENCES semantic.revision(route, subject_id, revision);


--
-- Name: revision revision_route_subject_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.revision
    ADD CONSTRAINT revision_route_subject_id_fkey FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id);


--
-- Name: source_candidate source_candidate_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.source_candidate
    ADD CONSTRAINT source_candidate_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- Name: statement_disclosure statement_disclosure_route_subject_id_candidate_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.statement_disclosure
    ADD CONSTRAINT statement_disclosure_route_subject_id_candidate_id_fkey FOREIGN KEY (route, subject_id, candidate_id) REFERENCES semantic.candidate(route, subject_id, candidate_id);


--
-- PostgreSQL database dump complete
--


