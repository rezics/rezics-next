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
-- Name: acquire_identity_epoch_admission(integer, uuid, bigint, text); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.acquire_identity_epoch_admission(p_home integer, p_job uuid, p_epoch bigint, p_scope text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE a semantic.identity_epoch_admission_attempt; c semantic.identity_epoch_control;
BEGIN
  SELECT * INTO c FROM semantic.identity_epoch_control WHERE partition_no=p_home FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
  SELECT * INTO a FROM semantic.identity_epoch_admission_attempt
    WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
  IF FOUND THEN
    IF a.state='closed' OR a.job_epoch<>p_epoch OR a.scope_digest<>p_scope THEN
      RAISE EXCEPTION 'identity_effect_stale';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_plan
    WHERE job_id=p_job AND resource_home=p_home) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  PERFORM 1 FROM semantic.identity_epoch_group g JOIN semantic.identity_epoch_input i
    ON (i.control_partition,i.terminal)=(g.partition_no,g.terminal)
    WHERE i.job_id=p_job AND g.partition_no=p_home ORDER BY g.terminal FOR UPDATE OF g;
  IF EXISTS(SELECT 1 FROM semantic.identity_epoch_group g JOIN semantic.identity_epoch_input i
    ON (i.control_partition,i.terminal)=(g.partition_no,g.terminal)
    WHERE i.job_id=p_job AND g.partition_no=p_home AND g.pending_job IS NOT NULL AND g.pending_job<>p_job)
    THEN RAISE EXCEPTION 'identity_epoch_busy'; END IF;
  IF c.pending_job IS NOT NULL AND c.pending_job<>p_job THEN RAISE EXCEPTION 'identity_epoch_unavailable'; END IF;
  IF EXISTS(SELECT 1 FROM semantic.identity_epoch_input i LEFT JOIN semantic.identity_epoch_group g
    ON (g.partition_no,g.terminal,g.generation,g.version,g.owner_epoch)=
       (i.control_partition,i.terminal,i.generation,i.basis_version,i.owner_epoch)
    LEFT JOIN core.partition o ON o.partition_no=i.control_partition AND o.epoch=i.owner_epoch AND o.write_state='active'
    WHERE i.job_id=p_job AND i.control_partition=p_home AND (g.terminal IS NULL OR o.partition_no IS NULL))
    THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  INSERT INTO semantic.identity_epoch_admission_attempt VALUES(p_home,p_job,p_epoch,p_scope,'acquired');
  UPDATE semantic.identity_epoch_group SET pending_job=p_job,pending_epoch=p_epoch
    WHERE partition_no=p_home AND terminal IN
      (SELECT terminal FROM semantic.identity_epoch_input WHERE job_id=p_job AND control_partition=p_home);
  UPDATE semantic.identity_epoch_control SET pending_job=p_job,pending_epoch=p_epoch,
    allocated_epoch=greatest(allocated_epoch,p_epoch) WHERE partition_no=p_home;
END; $$;


--
-- Name: capture_identity_epoch_key(integer, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_key(r integer, id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE semantic.identity_epoch_bootstrap_home SET needs_work=true,sealed_generation=NULL,sealed_transaction_id=NULL,sealed_epoch=NULL,sealed_position=NULL WHERE partition_no=r/16;
  INSERT INTO semantic.identity_epoch_dirty(route,original) VALUES(r,id)
  ON CONFLICT(route,original) DO UPDATE SET revision=semantic.identity_epoch_dirty.revision+1;
  UPDATE semantic.identity_epoch_group SET ready=false,version=version+1
  WHERE partition_no=r/16 AND terminal=id AND pending_job IS NULL;
END; $$;


--
-- Name: capture_identity_epoch_source(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.capture_identity_epoch_source() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME='merge_member' THEN
    IF TG_OP='UPDATE' AND (OLD.route,OLD.subject_id,OLD.member_id)=(NEW.route,NEW.subject_id,NEW.member_id) THEN RETURN NEW; END IF;
    IF TG_OP IN ('UPDATE','DELETE') THEN
      INSERT INTO semantic.identity_epoch_member_dirty(route,terminal,original) VALUES(OLD.route,OLD.subject_id,OLD.member_id)
      ON CONFLICT(route,terminal,original) DO UPDATE SET revision=semantic.identity_epoch_member_dirty.revision+1;
      PERFORM semantic.capture_identity_epoch_key(OLD.route,OLD.subject_id);
    END IF;
    IF TG_OP IN ('UPDATE','INSERT') THEN
      INSERT INTO semantic.identity_epoch_member_dirty(route,terminal,original) VALUES(NEW.route,NEW.subject_id,NEW.member_id)
      ON CONFLICT(route,terminal,original) DO UPDATE SET revision=semantic.identity_epoch_member_dirty.revision+1;
      PERFORM semantic.capture_identity_epoch_key(NEW.route,NEW.subject_id);
    END IF;
  ELSE
    IF TG_OP IN ('UPDATE','DELETE') THEN PERFORM semantic.capture_identity_epoch_key(OLD.route,OLD.subject_id); END IF;
    IF TG_OP IN ('UPDATE','INSERT') THEN PERFORM semantic.capture_identity_epoch_key(NEW.route,NEW.subject_id); END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$;


--
-- Name: close_identity_epoch_admission(integer, uuid, bigint, text); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.close_identity_epoch_admission(p_home integer, p_job uuid, p_epoch bigint, p_scope text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE a semantic.identity_epoch_admission_attempt;
BEGIN
  PERFORM 1 FROM semantic.identity_epoch_control WHERE partition_no=p_home FOR UPDATE;
  SELECT * INTO a FROM semantic.identity_epoch_admission_attempt
    WHERE partition_no=p_home AND job_id=p_job FOR UPDATE;
  IF FOUND AND (a.job_epoch<>p_epoch OR a.scope_digest<>p_scope) THEN RAISE EXCEPTION 'identity_effect_stale'; END IF;
  INSERT INTO semantic.identity_epoch_admission_attempt VALUES(p_home,p_job,p_epoch,p_scope,'closed')
    ON CONFLICT(partition_no,job_id) DO UPDATE SET state='closed';
  UPDATE semantic.identity_epoch_group SET pending_job=NULL,pending_epoch=NULL
    WHERE partition_no=p_home AND pending_job=p_job AND pending_epoch=p_epoch;
  UPDATE semantic.identity_epoch_control SET pending_job=NULL,pending_epoch=NULL
    WHERE partition_no=p_home AND pending_job=p_job AND pending_epoch=p_epoch;
END; $$;


--
-- Name: context_extension_head(integer, uuid); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.context_extension_head(p_route integer, p_context_id uuid) RETURNS TABLE(digest text, head integer)
    LANGUAGE sql STABLE
    SET enable_seqscan TO 'off'
    AS $$
  SELECT activation.digest, activation.head
  FROM semantic.context_extension_activation activation
  WHERE activation.route = p_route AND activation.context_id = p_context_id
  ORDER BY activation.head DESC
  LIMIT 1
$$;


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


--
-- Name: protect_identity_epoch_job(); Type: FUNCTION; Schema: semantic; Owner: -
--

CREATE FUNCTION semantic.protect_identity_epoch_job() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') OR OLD.state='published' THEN
    RAISE EXCEPTION 'Identity job intent and receipts are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;


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
    context_id uuid DEFAULT '00000000-0000-8000-8000-000000000000'::uuid NOT NULL,
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
-- Name: context_extension; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.context_extension (
    route integer NOT NULL,
    context_id uuid NOT NULL,
    digest text NOT NULL,
    body jsonb NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT context_extension_check CHECK ((route = ((get_byte(uuid_send(context_id), 10) * 256) + get_byte(uuid_send(context_id), 11)))),
    CONSTRAINT context_extension_digest_check CHECK ((digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT context_extension_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: context_extension_activation; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.context_extension_activation (
    route integer NOT NULL,
    context_id uuid NOT NULL,
    head integer NOT NULL,
    digest text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT context_extension_activation_head_check CHECK ((head >= 1)),
    CONSTRAINT context_extension_activation_route_check CHECK (((route >= 0) AND (route <= 65535)))
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
-- Name: identity_epoch_ack; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_ack (
    partition_no integer DEFAULT 0 NOT NULL,
    job_id uuid NOT NULL,
    step text NOT NULL,
    version integer NOT NULL,
    scope_digest text NOT NULL,
    progress jsonb NOT NULL,
    native_partition integer NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    native_transaction_id uuid NOT NULL,
    CONSTRAINT identity_epoch_ack_step_check CHECK ((step = ANY (ARRAY['mapping'::text, 'search-canonical-index'::text, 'library-private-follow-counts'::text]))),
    CONSTRAINT identity_epoch_ack_version_check CHECK ((version = 1))
);


--
-- Name: identity_epoch_admission_attempt; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_attempt (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    scope_digest text NOT NULL,
    state text NOT NULL,
    CONSTRAINT identity_epoch_admission_attempt_state_check CHECK ((state = ANY (ARRAY['acquired'::text, 'closed'::text])))
);


--
-- Name: identity_epoch_admission_plan; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_plan (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    resource_home integer NOT NULL,
    acquired_transaction_id uuid,
    acquired_epoch integer,
    acquired_position bigint,
    closed_transaction_id uuid,
    closed_epoch integer,
    closed_position bigint
);


--
-- Name: identity_epoch_admission_receipt; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_receipt (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    scope_digest text NOT NULL,
    stage text NOT NULL,
    version integer NOT NULL,
    CONSTRAINT identity_epoch_admission_receipt_stage_check CHECK ((stage = ANY (ARRAY['acquired'::text, 'closed'::text]))),
    CONSTRAINT identity_epoch_admission_receipt_version_check CHECK ((version = 1))
);


--
-- Name: identity_epoch_admission_source; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_admission_source (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    original uuid NOT NULL,
    route integer NOT NULL,
    control_partition integer NOT NULL,
    terminal uuid NOT NULL,
    generation uuid NOT NULL,
    basis_version bigint NOT NULL,
    source_revision bigint NOT NULL,
    source_transaction_id uuid NOT NULL,
    owner_epoch integer NOT NULL,
    source_owner_epoch integer NOT NULL
);


--
-- Name: identity_epoch_bootstrap_custody; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_custody (
    partition_no integer DEFAULT 0 NOT NULL,
    source_partition integer NOT NULL,
    source_generation bigint NOT NULL,
    native_transaction_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    stage text DEFAULT 'add'::text NOT NULL,
    CONSTRAINT identity_epoch_bootstrap_custody_stage_check CHECK ((stage = ANY (ARRAY['withdraw'::text, 'add'::text])))
);


--
-- Name: identity_epoch_bootstrap_home; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_home (
    partition_no integer NOT NULL,
    phase text NOT NULL,
    after_route integer NOT NULL,
    after_original uuid NOT NULL,
    after_member uuid NOT NULL,
    generation bigint DEFAULT 0 NOT NULL,
    owner_epoch integer,
    needs_work boolean DEFAULT true NOT NULL,
    sealed_generation bigint,
    sealed_transaction_id uuid,
    sealed_epoch integer,
    sealed_position bigint,
    CONSTRAINT identity_epoch_bootstrap_home_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_epoch_bootstrap_home_phase_check CHECK ((phase = ANY (ARRAY['subjects'::text, 'members'::text, 'dirty'::text, 'member-dirty'::text])))
);


--
-- Name: identity_epoch_bootstrap_page; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_page (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    generation bigint NOT NULL,
    phase text NOT NULL,
    caught_up boolean DEFAULT false NOT NULL,
    acknowledged boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_epoch_bootstrap_page_phase_check CHECK ((phase = ANY (ARRAY['subjects'::text, 'members'::text, 'dirty'::text, 'member-dirty'::text])))
);


--
-- Name: identity_epoch_bootstrap_row; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_row (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    route integer NOT NULL,
    original uuid NOT NULL,
    terminal uuid NOT NULL,
    source_revision bigint NOT NULL,
    present boolean NOT NULL,
    previous_partition integer,
    previous_terminal uuid
);


--
-- Name: identity_epoch_bootstrap_topology; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_topology (
    partition_no integer NOT NULL,
    next_partition integer DEFAULT 0 NOT NULL,
    remaining integer DEFAULT 4096 NOT NULL,
    CONSTRAINT identity_epoch_bootstrap_topology_next_partition_check CHECK (((next_partition >= 0) AND (next_partition <= 4095))),
    CONSTRAINT identity_epoch_bootstrap_topology_partition_no_check CHECK ((partition_no = 0)),
    CONSTRAINT identity_epoch_bootstrap_topology_remaining_check CHECK (((remaining >= 0) AND (remaining <= 4096)))
);


--
-- Name: identity_epoch_bootstrap_topology_home; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_bootstrap_topology_home (
    source_partition integer CONSTRAINT identity_epoch_bootstrap_topology_hom_source_partition_not_null NOT NULL,
    closed boolean DEFAULT false NOT NULL,
    CONSTRAINT identity_epoch_bootstrap_topology_home_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095)))
);


--
-- Name: identity_epoch_change; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_change (
    partition_no integer DEFAULT 0 NOT NULL,
    job_id uuid NOT NULL,
    original uuid NOT NULL,
    previous_terminal uuid NOT NULL,
    terminal uuid NOT NULL
);


--
-- Name: identity_epoch_control; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_control (
    partition_no integer NOT NULL,
    published_epoch bigint NOT NULL,
    pending_job uuid,
    pending_epoch bigint,
    allocated_epoch bigint DEFAULT 1 NOT NULL,
    CONSTRAINT identity_epoch_control_check CHECK (((pending_job IS NULL) = (pending_epoch IS NULL))),
    CONSTRAINT identity_epoch_control_published_epoch_check CHECK ((published_epoch >= 0))
);


--
-- Name: identity_epoch_dirty; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_dirty (
    route integer NOT NULL,
    original uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    captured_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT identity_epoch_dirty_check CHECK (((revision >= captured_revision) AND (captured_revision >= 0)))
);


--
-- Name: identity_epoch_effect_receipt; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_effect_receipt (
    partition_no integer DEFAULT 0 NOT NULL,
    job_id uuid NOT NULL,
    step text NOT NULL,
    effect_key text NOT NULL,
    kind text NOT NULL,
    native_partition integer,
    native_epoch integer,
    native_position bigint,
    native_transaction_id uuid,
    CONSTRAINT identity_epoch_effect_receipt_check CHECK (((native_transaction_id IS NULL) = (native_partition IS NULL))),
    CONSTRAINT identity_epoch_effect_receipt_check1 CHECK (((native_transaction_id IS NULL) = (native_epoch IS NULL))),
    CONSTRAINT identity_epoch_effect_receipt_check2 CHECK (((native_transaction_id IS NULL) = (native_position IS NULL))),
    CONSTRAINT identity_epoch_effect_receipt_kind_check CHECK ((kind = ANY (ARRAY['remove'::text, 'add'::text, 'pending-fence'::text, 'published-fence'::text]))),
    CONSTRAINT identity_epoch_effect_receipt_step_check CHECK ((step = ANY (ARRAY['mapping'::text, 'search-canonical-index'::text, 'library-private-follow-counts'::text])))
);


--
-- Name: identity_epoch_group; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_group (
    partition_no integer DEFAULT 0 NOT NULL,
    terminal uuid NOT NULL,
    observed_count bigint NOT NULL,
    generation uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_epoch integer,
    version bigint DEFAULT 1 NOT NULL,
    ready boolean DEFAULT false NOT NULL,
    published_epoch bigint DEFAULT 1 NOT NULL,
    pending_job uuid,
    pending_epoch bigint,
    CONSTRAINT identity_epoch_group_observed_count_check CHECK ((observed_count >= 0))
);


--
-- Name: identity_epoch_home_gate; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_home_gate (
    route integer NOT NULL,
    destination uuid NOT NULL,
    original uuid NOT NULL,
    terminal uuid NOT NULL,
    epoch bigint NOT NULL,
    pending_job uuid,
    pending_epoch bigint,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT identity_epoch_home_gate_check CHECK ((route = ((get_byte(uuid_send(destination), 10) * 256) + get_byte(uuid_send(destination), 11)))),
    CONSTRAINT identity_epoch_home_gate_check1 CHECK (((pending_job IS NULL) = (pending_epoch IS NULL))),
    CONSTRAINT identity_epoch_home_gate_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT identity_epoch_home_gate_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: identity_epoch_input; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_input (
    partition_no integer NOT NULL,
    job_id uuid NOT NULL,
    terminal uuid NOT NULL,
    generation uuid NOT NULL,
    basis_version bigint NOT NULL,
    original_count bigint NOT NULL,
    control_partition integer NOT NULL,
    owner_epoch integer
);


--
-- Name: identity_epoch_job; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_job (
    partition_no integer DEFAULT 0 NOT NULL,
    job_id uuid NOT NULL,
    epoch bigint NOT NULL,
    intent jsonb NOT NULL,
    receipt_key text NOT NULL,
    receipt jsonb NOT NULL,
    scope_digest text NOT NULL,
    state text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT identity_epoch_job_epoch_check CHECK ((epoch > 0)),
    CONSTRAINT identity_epoch_job_state_check CHECK ((state = ANY (ARRAY['preparing'::text, 'pending'::text, 'cancelling'::text, 'cancelled'::text, 'published'::text])))
);


--
-- Name: identity_epoch_legacy_member; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_legacy_member (
    partition_no integer DEFAULT 0 NOT NULL,
    terminal uuid NOT NULL,
    original uuid NOT NULL,
    source_partition integer NOT NULL,
    source_generation bigint NOT NULL
);


--
-- Name: identity_epoch_mapping; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_mapping (
    route integer NOT NULL,
    original uuid NOT NULL,
    terminal uuid NOT NULL,
    epoch bigint NOT NULL,
    origin text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    control_partition integer,
    control_group uuid,
    source_revision bigint DEFAULT 0 NOT NULL,
    owner_epoch integer DEFAULT 1 NOT NULL,
    CONSTRAINT identity_epoch_mapping_check CHECK ((route = ((get_byte(uuid_send(original), 10) * 256) + get_byte(uuid_send(original), 11)))),
    CONSTRAINT identity_epoch_mapping_epoch_check CHECK ((epoch >= 0)),
    CONSTRAINT identity_epoch_mapping_origin_check CHECK ((origin = ANY (ARRAY['creation'::text, 'published'::text]))),
    CONSTRAINT identity_epoch_mapping_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: identity_epoch_member_dirty; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_member_dirty (
    route integer NOT NULL,
    terminal uuid NOT NULL,
    original uuid NOT NULL,
    revision bigint DEFAULT 1 NOT NULL,
    captured_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT identity_epoch_member_dirty_check CHECK (((revision >= captured_revision) AND (captured_revision >= 0)))
);


--
-- Name: identity_epoch_native_commit; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_native_commit (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    epoch integer NOT NULL,
    "position" bigint NOT NULL,
    purpose text NOT NULL,
    CONSTRAINT identity_epoch_native_commit_partition_no_check CHECK (((partition_no >= 0) AND (partition_no <= 4095))),
    CONSTRAINT identity_epoch_native_commit_purpose_check CHECK ((purpose = ANY (ARRAY['bootstrap'::text, 'admission'::text, 'mapping'::text, 'search-canonical-index'::text, 'library-private-follow-counts'::text])))
);


--
-- Name: identity_epoch_original; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_original (
    partition_no integer DEFAULT 0 NOT NULL,
    original uuid NOT NULL,
    terminal uuid NOT NULL,
    source_partition integer NOT NULL,
    source_generation bigint NOT NULL,
    present boolean NOT NULL,
    generation uuid NOT NULL
);


--
-- Name: identity_epoch_step; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_step (
    partition_no integer NOT NULL,
    transaction_id uuid NOT NULL,
    native_epoch integer NOT NULL,
    native_position bigint NOT NULL,
    job_id uuid NOT NULL,
    job_epoch bigint NOT NULL,
    step text NOT NULL,
    version integer NOT NULL,
    scope_digest text NOT NULL,
    frontier jsonb NOT NULL,
    state text NOT NULL,
    work jsonb NOT NULL,
    CONSTRAINT identity_epoch_step_frontier_check CHECK (((octet_length((frontier)::text) <= 2048) AND (jsonb_array_length((frontier -> 'after'::text)) <= 8))),
    CONSTRAINT identity_epoch_step_state_check CHECK ((state = ANY (ARRAY['more'::text, 'complete'::text]))),
    CONSTRAINT identity_epoch_step_step_check CHECK ((step = ANY (ARRAY['mapping'::text, 'search-canonical-index'::text, 'library-private-follow-counts'::text]))),
    CONSTRAINT identity_epoch_step_version_check CHECK ((version = 1))
);


--
-- Name: identity_epoch_topology_custody; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.identity_epoch_topology_custody (
    source_partition integer NOT NULL,
    source_generation bigint NOT NULL,
    source_epoch integer NOT NULL,
    source_transaction_id uuid NOT NULL,
    source_position bigint NOT NULL,
    CONSTRAINT identity_epoch_topology_custody_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095)))
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
-- Name: release_composite; Type: TABLE; Schema: semantic; Owner: -
--

CREATE TABLE semantic.release_composite (
    digest text NOT NULL,
    parent_digest text NOT NULL,
    extension_route integer NOT NULL,
    extension_context_id uuid NOT NULL,
    extension_digest text NOT NULL,
    CONSTRAINT release_composite_digest_check CHECK ((digest ~ '^sha256:[0-9a-f]{64}$'::text)),
    CONSTRAINT release_composite_parent_digest_check CHECK ((parent_digest ~ '^sha256:[0-9a-f]{64}$'::text))
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
    ADD CONSTRAINT account_agent_moved_link_pkey PRIMARY KEY (route, receipt_id, moved_from, property, source_subject_id, statement_id, filter_value, context_id);


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
-- Name: context_extension_activation context_extension_activation_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_extension_activation
    ADD CONSTRAINT context_extension_activation_pkey PRIMARY KEY (route, context_id, head);


--
-- Name: context_extension context_extension_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_extension
    ADD CONSTRAINT context_extension_pkey PRIMARY KEY (route, context_id, digest);


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
-- Name: identity_epoch_ack identity_epoch_ack_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_ack
    ADD CONSTRAINT identity_epoch_ack_pkey PRIMARY KEY (job_id, step);


--
-- Name: identity_epoch_admission_attempt identity_epoch_admission_attempt_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_attempt
    ADD CONSTRAINT identity_epoch_admission_attempt_pkey PRIMARY KEY (partition_no, job_id);


--
-- Name: identity_epoch_admission_plan identity_epoch_admission_plan_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_plan
    ADD CONSTRAINT identity_epoch_admission_plan_pkey PRIMARY KEY (job_id, resource_home);


--
-- Name: identity_epoch_admission_receipt identity_epoch_admission_receipt_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_receipt
    ADD CONSTRAINT identity_epoch_admission_receipt_pkey PRIMARY KEY (partition_no, job_id, stage);


--
-- Name: identity_epoch_admission_source identity_epoch_admission_source_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_source
    ADD CONSTRAINT identity_epoch_admission_source_pkey PRIMARY KEY (job_id, original);


--
-- Name: identity_epoch_bootstrap_custody identity_epoch_bootstrap_custody_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_custody
    ADD CONSTRAINT identity_epoch_bootstrap_custody_pkey PRIMARY KEY (partition_no, source_partition, source_generation, stage);


--
-- Name: identity_epoch_bootstrap_home identity_epoch_bootstrap_home_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_home
    ADD CONSTRAINT identity_epoch_bootstrap_home_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_epoch_bootstrap_page identity_epoch_bootstrap_page_partition_no_generation_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_page
    ADD CONSTRAINT identity_epoch_bootstrap_page_partition_no_generation_key UNIQUE (partition_no, generation);


--
-- Name: identity_epoch_bootstrap_page identity_epoch_bootstrap_page_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_page
    ADD CONSTRAINT identity_epoch_bootstrap_page_pkey PRIMARY KEY (partition_no, transaction_id);


--
-- Name: identity_epoch_bootstrap_row identity_epoch_bootstrap_row_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_row
    ADD CONSTRAINT identity_epoch_bootstrap_row_pkey PRIMARY KEY (partition_no, transaction_id, original, terminal);


--
-- Name: identity_epoch_bootstrap_topology_home identity_epoch_bootstrap_topology_home_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_topology_home
    ADD CONSTRAINT identity_epoch_bootstrap_topology_home_pkey PRIMARY KEY (source_partition);


--
-- Name: identity_epoch_bootstrap_topology identity_epoch_bootstrap_topology_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_topology
    ADD CONSTRAINT identity_epoch_bootstrap_topology_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_epoch_change identity_epoch_change_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_change
    ADD CONSTRAINT identity_epoch_change_pkey PRIMARY KEY (job_id, original);


--
-- Name: identity_epoch_control identity_epoch_control_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_control
    ADD CONSTRAINT identity_epoch_control_pkey PRIMARY KEY (partition_no);


--
-- Name: identity_epoch_dirty identity_epoch_dirty_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_dirty
    ADD CONSTRAINT identity_epoch_dirty_pkey PRIMARY KEY (route, original);


--
-- Name: identity_epoch_effect_receipt identity_epoch_effect_receipt_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_effect_receipt
    ADD CONSTRAINT identity_epoch_effect_receipt_pkey PRIMARY KEY (job_id, step, effect_key);


--
-- Name: identity_epoch_group identity_epoch_group_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_group
    ADD CONSTRAINT identity_epoch_group_pkey PRIMARY KEY (terminal);


--
-- Name: identity_epoch_home_gate identity_epoch_home_gate_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_home_gate
    ADD CONSTRAINT identity_epoch_home_gate_pkey PRIMARY KEY (route, destination, original);


--
-- Name: identity_epoch_input identity_epoch_input_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_input
    ADD CONSTRAINT identity_epoch_input_pkey PRIMARY KEY (job_id, terminal);


--
-- Name: identity_epoch_job identity_epoch_job_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_job
    ADD CONSTRAINT identity_epoch_job_pkey PRIMARY KEY (job_id);


--
-- Name: identity_epoch_job identity_epoch_job_receipt_key_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_job
    ADD CONSTRAINT identity_epoch_job_receipt_key_key UNIQUE (receipt_key);


--
-- Name: identity_epoch_legacy_member identity_epoch_legacy_member_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_legacy_member
    ADD CONSTRAINT identity_epoch_legacy_member_pkey PRIMARY KEY (terminal, original);


--
-- Name: identity_epoch_mapping identity_epoch_mapping_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping
    ADD CONSTRAINT identity_epoch_mapping_pkey PRIMARY KEY (route, original);


--
-- Name: identity_epoch_member_dirty identity_epoch_member_dirty_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_member_dirty
    ADD CONSTRAINT identity_epoch_member_dirty_pkey PRIMARY KEY (route, terminal, original);


--
-- Name: identity_epoch_native_commit identity_epoch_native_commit_partition_no_transaction_id_ep_key; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_native_commit
    ADD CONSTRAINT identity_epoch_native_commit_partition_no_transaction_id_ep_key UNIQUE (partition_no, transaction_id, epoch, "position");


--
-- Name: identity_epoch_native_commit identity_epoch_native_commit_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_native_commit
    ADD CONSTRAINT identity_epoch_native_commit_pkey PRIMARY KEY (partition_no, transaction_id);


--
-- Name: identity_epoch_original identity_epoch_original_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_original
    ADD CONSTRAINT identity_epoch_original_pkey PRIMARY KEY (generation, original);


--
-- Name: identity_epoch_step identity_epoch_step_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_step
    ADD CONSTRAINT identity_epoch_step_pkey PRIMARY KEY (partition_no, transaction_id, job_id, step);


--
-- Name: identity_epoch_topology_custody identity_epoch_topology_custody_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_topology_custody
    ADD CONSTRAINT identity_epoch_topology_custody_pkey PRIMARY KEY (source_partition);


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
-- Name: release_composite release_composite_pkey; Type: CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.release_composite
    ADD CONSTRAINT release_composite_pkey PRIMARY KEY (digest);


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
-- Name: identity_epoch_bootstrap_repair; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_bootstrap_repair ON semantic.identity_epoch_bootstrap_home USING btree (partition_no) WHERE needs_work;


--
-- Name: identity_epoch_bootstrap_unacknowledged; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_bootstrap_unacknowledged ON semantic.identity_epoch_bootstrap_page USING btree (partition_no, generation) WHERE (NOT acknowledged);


--
-- Name: identity_epoch_current_original; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_current_original ON semantic.identity_epoch_original USING btree (partition_no, original) WHERE present;


--
-- Name: identity_epoch_dirty_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_dirty_pending ON semantic.identity_epoch_dirty USING btree (route, original) WHERE (revision > captured_revision);


--
-- Name: identity_epoch_generation_original; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_generation_original ON semantic.identity_epoch_original USING btree (generation, original) WHERE present;


--
-- Name: identity_epoch_job_home_epoch; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_job_home_epoch ON semantic.identity_epoch_job USING btree (partition_no, epoch);


--
-- Name: identity_epoch_member_dirty_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_member_dirty_pending ON semantic.identity_epoch_member_dirty USING btree (route, terminal, original) WHERE (revision > captured_revision);


--
-- Name: identity_epoch_one_pending; Type: INDEX; Schema: semantic; Owner: -
--

CREATE UNIQUE INDEX identity_epoch_one_pending ON semantic.identity_epoch_job USING btree (partition_no) WHERE (state = ANY (ARRAY['preparing'::text, 'pending'::text, 'cancelling'::text]));


--
-- Name: identity_epoch_original_group; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_original_group ON semantic.identity_epoch_original USING btree (terminal, original) WHERE present;


--
-- Name: identity_epoch_original_source; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_original_source ON semantic.identity_epoch_original USING btree (source_partition, original) WHERE present;


--
-- Name: identity_epoch_preparing_home; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_preparing_home ON semantic.identity_epoch_job USING btree (partition_no) WHERE (state = ANY (ARRAY['preparing'::text, 'cancelling'::text]));


--
-- Name: identity_epoch_topology_open_home; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX identity_epoch_topology_open_home ON semantic.identity_epoch_bootstrap_topology_home USING btree (source_partition) WHERE (NOT closed);


--
-- Name: inbound_link_all_present; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_all_present ON semantic.inbound_link USING btree (route, subject_id, context_id, property, source_subject_id, statement_id) INCLUDE (source_type, suppressed) WHERE (present AND (filter_value = '00000000-0000-0000-0000-000000000000'::uuid));


--
-- Name: inbound_link_context_overrides; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_context_overrides ON semantic.inbound_link USING btree (route, subject_id, property, filter_value, statement_id, source_subject_id, context_id) WHERE (present AND (context_id <> '00000000-0000-8000-8000-000000000000'::uuid));


--
-- Name: inbound_link_count_unfiltered; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX inbound_link_count_unfiltered ON semantic.inbound_link_count USING btree (route, subject_id, property) INCLUDE (value) WHERE ((filter_value = '00000000-0000-0000-0000-000000000000'::uuid) AND (value > 0));


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
-- Name: outbound_link_count_unfiltered; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX outbound_link_count_unfiltered ON semantic.outbound_link_count USING btree (route, subject_id, property) INCLUDE (value) WHERE ((filter_value = '00000000-0000-0000-0000-000000000000'::uuid) AND (value > 0));


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
-- Name: revision_identity_version; Type: INDEX; Schema: semantic; Owner: -
--

CREATE INDEX revision_identity_version ON semantic.revision USING btree (route, subject_id, revision DESC) INCLUDE (recorded_transaction_id) WHERE (kind = ANY (ARRAY['create'::text, 'identity'::text]));


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
-- Name: identity_epoch_admission_receipt identity_epoch_admission_receipt_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_admission_receipt_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_admission_receipt FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_bootstrap_custody identity_epoch_bootstrap_custody_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_bootstrap_custody_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_bootstrap_custody FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: account_agent_subject identity_epoch_capture_backlink; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_capture_backlink AFTER DELETE OR UPDATE ON semantic.account_agent_subject FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();


--
-- Name: merge_member identity_epoch_capture_member; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_capture_member AFTER INSERT OR DELETE OR UPDATE ON semantic.merge_member FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();


--
-- Name: redirect identity_epoch_capture_redirect; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_capture_redirect AFTER INSERT OR DELETE OR UPDATE ON semantic.redirect FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();


--
-- Name: subject identity_epoch_capture_subject; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_capture_subject AFTER INSERT OR DELETE ON semantic.subject FOR EACH ROW EXECUTE FUNCTION semantic.capture_identity_epoch_source();


--
-- Name: identity_epoch_change identity_epoch_change_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_change_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_change FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_change identity_epoch_change_immutable_truncate; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_change_immutable_truncate BEFORE TRUNCATE ON semantic.identity_epoch_change FOR EACH STATEMENT EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_job identity_epoch_job_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_job_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_job FOR EACH ROW EXECUTE FUNCTION semantic.protect_identity_epoch_job();


--
-- Name: identity_epoch_native_commit identity_epoch_native_commit_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_native_commit_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_native_commit FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


--
-- Name: identity_epoch_step identity_epoch_step_immutable; Type: TRIGGER; Schema: semantic; Owner: -
--

CREATE TRIGGER identity_epoch_step_immutable BEFORE DELETE OR UPDATE ON semantic.identity_epoch_step FOR EACH ROW EXECUTE FUNCTION semantic.prevent_revision_mutation();


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
-- Name: context_extension_activation context_extension_activation_route_context_id_digest_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.context_extension_activation
    ADD CONSTRAINT context_extension_activation_route_context_id_digest_fkey FOREIGN KEY (route, context_id, digest) REFERENCES semantic.context_extension(route, context_id, digest);


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
-- Name: identity_epoch_ack identity_epoch_ack_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_ack
    ADD CONSTRAINT identity_epoch_ack_job_id_fkey FOREIGN KEY (job_id) REFERENCES semantic.identity_epoch_job(job_id);


--
-- Name: identity_epoch_admission_plan identity_epoch_admission_plan_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_plan
    ADD CONSTRAINT identity_epoch_admission_plan_job_id_fkey FOREIGN KEY (job_id) REFERENCES semantic.identity_epoch_job(job_id);


--
-- Name: identity_epoch_admission_receipt identity_epoch_admission_rece_partition_no_transaction_id__fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_receipt
    ADD CONSTRAINT identity_epoch_admission_rece_partition_no_transaction_id__fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position");


--
-- Name: identity_epoch_admission_source identity_epoch_admission_source_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_admission_source
    ADD CONSTRAINT identity_epoch_admission_source_job_id_fkey FOREIGN KEY (job_id) REFERENCES semantic.identity_epoch_job(job_id);


--
-- Name: identity_epoch_bootstrap_page identity_epoch_bootstrap_page_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_page
    ADD CONSTRAINT identity_epoch_bootstrap_page_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id);


--
-- Name: identity_epoch_bootstrap_row identity_epoch_bootstrap_row_partition_no_transaction_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_bootstrap_row
    ADD CONSTRAINT identity_epoch_bootstrap_row_partition_no_transaction_id_fkey FOREIGN KEY (partition_no, transaction_id) REFERENCES semantic.identity_epoch_bootstrap_page(partition_no, transaction_id);


--
-- Name: identity_epoch_change identity_epoch_change_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_change
    ADD CONSTRAINT identity_epoch_change_job_id_fkey FOREIGN KEY (job_id) REFERENCES semantic.identity_epoch_job(job_id);


--
-- Name: identity_epoch_effect_receipt identity_epoch_effect_receipt_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_effect_receipt
    ADD CONSTRAINT identity_epoch_effect_receipt_job_id_fkey FOREIGN KEY (job_id) REFERENCES semantic.identity_epoch_job(job_id);


--
-- Name: identity_epoch_input identity_epoch_input_job_id_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_input
    ADD CONSTRAINT identity_epoch_input_job_id_fkey FOREIGN KEY (job_id) REFERENCES semantic.identity_epoch_job(job_id);


--
-- Name: identity_epoch_mapping identity_epoch_mapping_route_original_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_mapping
    ADD CONSTRAINT identity_epoch_mapping_route_original_fkey FOREIGN KEY (route, original) REFERENCES semantic.subject(route, subject_id);


--
-- Name: identity_epoch_step identity_epoch_step_partition_no_transaction_id_native_epo_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.identity_epoch_step
    ADD CONSTRAINT identity_epoch_step_partition_no_transaction_id_native_epo_fkey FOREIGN KEY (partition_no, transaction_id, native_epoch, native_position) REFERENCES semantic.identity_epoch_native_commit(partition_no, transaction_id, epoch, "position");


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
-- Name: release_composite release_composite_extension_route_extension_context_id_ext_fkey; Type: FK CONSTRAINT; Schema: semantic; Owner: -
--

ALTER TABLE ONLY semantic.release_composite
    ADD CONSTRAINT release_composite_extension_route_extension_context_id_ext_fkey FOREIGN KEY (extension_route, extension_context_id, extension_digest) REFERENCES semantic.context_extension(route, context_id, digest);


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


