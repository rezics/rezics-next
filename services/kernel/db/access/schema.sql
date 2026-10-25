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
-- Name: access; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA access;


--
-- Name: guard_account_identity(); Type: FUNCTION; Schema: access; Owner: -
--

CREATE FUNCTION access.guard_account_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.route IS DISTINCT FROM OLD.route THEN
    RAISE EXCEPTION 'Account ID, kind and route are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.minimum_authn_epoch < OLD.minimum_authn_epoch THEN
    RAISE EXCEPTION 'Authentication epoch floor cannot decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.account (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    handle text COLLATE pg_catalog."C",
    display_name text,
    avatar_url text,
    biography text,
    state text DEFAULT 'pending'::text NOT NULL,
    operator_account_id uuid,
    controller_id uuid,
    birth_date date,
    content_preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    suspension_reason text,
    minimum_authn_epoch bigint DEFAULT 1 NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT account_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_check1 CHECK (((operator_account_id IS NULL) OR ((kind = 'actor'::text) AND (operator_account_id <> account_id)))),
    CONSTRAINT account_content_preferences_check CHECK ((jsonb_typeof(content_preferences) = 'object'::text)),
    CONSTRAINT account_handle_check CHECK ((handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT account_kind_check CHECK ((kind = ANY (ARRAY['actor'::text, 'organization'::text]))),
    CONSTRAINT account_minimum_authn_epoch_check CHECK ((minimum_authn_epoch > 0)),
    CONSTRAINT account_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT account_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text, 'deleted'::text])))
);


--
-- Name: handle_claim; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.handle_claim (
    route integer NOT NULL,
    normalized_handle text NOT NULL COLLATE pg_catalog."C",
    account_id uuid NOT NULL,
    state text NOT NULL,
    expires_at timestamp with time zone,
    reserved_until timestamp with time zone,
    transaction_id uuid NOT NULL,
    CONSTRAINT handle_claim_check CHECK ((route = ((get_byte(sha256(convert_to(normalized_handle, 'UTF8'::name)), 0) * 256) + get_byte(sha256(convert_to(normalized_handle, 'UTF8'::name)), 1)))),
    CONSTRAINT handle_claim_check1 CHECK ((((state = 'pending'::text) AND (expires_at IS NOT NULL) AND (reserved_until IS NULL)) OR ((state = 'active'::text) AND (expires_at IS NULL) AND (reserved_until IS NULL)) OR ((state = 'reserved'::text) AND (expires_at IS NULL) AND (reserved_until IS NOT NULL)))),
    CONSTRAINT handle_claim_normalized_handle_check CHECK ((normalized_handle ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT handle_claim_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT handle_claim_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'reserved'::text])))
);


--
-- Name: organization_member; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.organization_member (
    route integer NOT NULL,
    organization_id uuid NOT NULL,
    member_account_id uuid NOT NULL,
    role text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT organization_member_check CHECK ((route = ((get_byte(uuid_send(organization_id), 10) * 256) + get_byte(uuid_send(organization_id), 11)))),
    CONSTRAINT organization_member_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text]))),
    CONSTRAINT organization_member_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT organization_member_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: principal_assignment; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.principal_assignment (
    route integer NOT NULL,
    principal_id uuid NOT NULL,
    request_id uuid NOT NULL,
    assigned_actor_id uuid NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT principal_assignment_check CHECK ((route = ((get_byte(uuid_send(principal_id), 10) * 256) + get_byte(uuid_send(principal_id), 11)))),
    CONSTRAINT principal_assignment_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT principal_assignment_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: resource_denial; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_denial (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    subject_role text DEFAULT ''::text NOT NULL,
    action text NOT NULL,
    reason text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT resource_denial_action_check CHECK ((action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'::text)),
    CONSTRAINT resource_denial_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_denial_reason_check CHECK ((reason = ANY (ARRAY['resource'::text, 'suspension'::text, 'realm_ban'::text]))),
    CONSTRAINT resource_denial_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_denial_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_denial_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: resource_grant; Type: TABLE; Schema: access; Owner: -
--

CREATE TABLE access.resource_grant (
    route integer NOT NULL,
    resource_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    subject_role text DEFAULT ''::text NOT NULL,
    action text NOT NULL,
    valid tstzrange NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT resource_grant_action_check CHECK ((action ~ '^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$'::text)),
    CONSTRAINT resource_grant_check CHECK ((route = ((get_byte(uuid_send(resource_id), 10) * 256) + get_byte(uuid_send(resource_id), 11)))),
    CONSTRAINT resource_grant_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT resource_grant_subject_role_check CHECK ((subject_role = ANY (ARRAY[''::text, 'owner'::text, 'member'::text]))),
    CONSTRAINT resource_grant_valid_check CHECK (((NOT isempty(valid)) AND (lower_inf(valid) OR lower_inc(valid)) AND (NOT upper_inc(valid))))
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (route, account_id);


--
-- Name: handle_claim handle_claim_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.handle_claim
    ADD CONSTRAINT handle_claim_pkey PRIMARY KEY (route, normalized_handle);


--
-- Name: organization_member organization_member_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.organization_member
    ADD CONSTRAINT organization_member_pkey PRIMARY KEY (route, organization_id, member_account_id, valid WITHOUT OVERLAPS);


--
-- Name: principal_assignment principal_assignment_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.principal_assignment
    ADD CONSTRAINT principal_assignment_pkey PRIMARY KEY (route, principal_id, request_id);


--
-- Name: resource_denial resource_denial_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_denial
    ADD CONSTRAINT resource_denial_pkey PRIMARY KEY (route, resource_id, subject_id, subject_role, action, reason, valid WITHOUT OVERLAPS);


--
-- Name: resource_grant resource_grant_pkey; Type: CONSTRAINT; Schema: access; Owner: -
--

ALTER TABLE ONLY access.resource_grant
    ADD CONSTRAINT resource_grant_pkey PRIMARY KEY (route, resource_id, subject_id, subject_role, action, valid WITHOUT OVERLAPS);


--
-- Name: account account_identity; Type: TRIGGER; Schema: access; Owner: -
--

CREATE TRIGGER account_identity BEFORE UPDATE ON access.account FOR EACH ROW EXECUTE FUNCTION access.guard_account_identity();


--
-- PostgreSQL database dump complete
--


