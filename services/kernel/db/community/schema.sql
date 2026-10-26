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
-- Name: community; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA community;


--
-- Name: guard_publication(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Publication records are append-only' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_publication_head(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_publication_head() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.realm_id, NEW.subject_id)
     IS DISTINCT FROM ROW(OLD.route, OLD.realm_id, OLD.subject_id) THEN
    RAISE EXCEPTION 'Publication slot identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_realm(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.realm_id, NEW.space_id, NEW.created_at, NEW.creator)
     IS DISTINCT FROM ROW(OLD.route, OLD.realm_id, OLD.space_id, OLD.created_at, OLD.creator) THEN
    RAISE EXCEPTION 'Realm identity and creation provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_realm_member_terminal(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_member_terminal() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Realm membership terminal slots are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_realm_revision(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_realm_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Realm revisions are append-only' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_space(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_space() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.space_id, NEW.created_at, NEW.creator)
     IS DISTINCT FROM ROW(OLD.route, OLD.space_id, OLD.created_at, OLD.creator) THEN
    RAISE EXCEPTION 'Space identity and creation provenance are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_space_revision(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.guard_space_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Space revisions are append-only' USING ERRCODE = '23514';
END;
$$;


--
-- Name: inherit_realm_board_scheme(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.inherit_realm_board_scheme() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT board_scheme_id INTO NEW.board_scheme_id
  FROM community.realm_revision
  WHERE route = NEW.route AND realm_id = NEW.realm_id AND revision_id = NEW.predecessor;
  RETURN NEW;
END;
$$;


--
-- Name: inherit_realm_votes(); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.inherit_realm_votes() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  SELECT votes INTO NEW.votes
  FROM community.realm_revision
  WHERE route = NEW.route AND realm_id = NEW.realm_id AND revision_id = NEW.predecessor;
  RETURN NEW;
END;
$$;


--
-- Name: realm_revision_votes(integer, uuid, uuid); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.realm_revision_votes(route integer, realm_id uuid, revision_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  found jsonb;
BEGIN
  SELECT revision.votes INTO found
  FROM community.realm_revision AS revision
  WHERE revision.route = realm_revision_votes.route
    AND revision.realm_id = realm_revision_votes.realm_id
    AND revision.revision_id = realm_revision_votes.revision_id;
  RETURN found;
END;
$$;


--
-- Name: realm_votes_allowed(jsonb); Type: FUNCTION; Schema: community; Owner: -
--

CREATE FUNCTION community.realm_votes_allowed(votes jsonb) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN votes IS NULL OR jsonb_typeof(votes) <> 'object' THEN false
    WHEN (SELECT count(*) FROM jsonb_object_keys(votes)) > 7 THEN false
    WHEN EXISTS (
      SELECT 1
      FROM jsonb_each(votes) AS entry(key, value)
      WHERE entry.key <> ALL (ARRAY['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'])
         OR jsonb_typeof(entry.value) <> 'number'
         OR (entry.value <> '1'::jsonb AND entry.value <> '-1'::jsonb)
    ) THEN false
    ELSE true
  END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: publication; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.publication (
    route integer NOT NULL,
    publication_id uuid NOT NULL,
    realm_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    verdict text NOT NULL,
    predecessor uuid,
    subject_revision_id uuid,
    actor uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT publication_check CHECK ((predecessor <> publication_id)),
    CONSTRAINT publication_check1 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT publication_check2 CHECK ((route = ((get_byte(uuid_send(publication_id), 10) * 256) + get_byte(uuid_send(publication_id), 11)))),
    CONSTRAINT publication_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT publication_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT publication_verdict_check CHECK ((verdict = ANY (ARRAY['adopt'::text, 'reject'::text, 'withdraw'::text])))
);


--
-- Name: publication_head; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.publication_head (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    publication_id uuid NOT NULL,
    verdict text NOT NULL,
    published_at timestamp with time zone NOT NULL,
    CONSTRAINT publication_head_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT publication_head_check1 CHECK ((route = ((get_byte(uuid_send(publication_id), 10) * 256) + get_byte(uuid_send(publication_id), 11)))),
    CONSTRAINT publication_head_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT publication_head_verdict_check CHECK ((verdict = ANY (ARRAY['adopt'::text, 'reject'::text, 'withdraw'::text])))
);


--
-- Name: realm; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    space_id uuid NOT NULL,
    state text NOT NULL,
    visibility text NOT NULL,
    context_id uuid NOT NULL,
    head_revision_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    creator uuid NOT NULL,
    board_scheme_id uuid,
    votes jsonb DEFAULT '{"upvote": 1, "downvote": -1}'::jsonb NOT NULL,
    CONSTRAINT realm_board_scheme_id_check CHECK (((board_scheme_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT realm_check CHECK ((realm_id <> space_id)),
    CONSTRAINT realm_check1 CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT realm_check2 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_check3 CHECK ((route = ((get_byte(uuid_send(head_revision_id), 10) * 256) + get_byte(uuid_send(head_revision_id), 11)))),
    CONSTRAINT realm_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_state_check CHECK ((state = 'active'::text)),
    CONSTRAINT realm_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'protected'::text]))),
    CONSTRAINT realm_votes_check CHECK (community.realm_votes_allowed(votes))
);


--
-- Name: realm_ban; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_ban (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    valid tstzrange NOT NULL,
    reason text NOT NULL,
    actor uuid NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT realm_ban_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_ban_reason_check CHECK ((char_length(reason) <= 1024)),
    CONSTRAINT realm_ban_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_ban_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: realm_member; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_member (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    role text NOT NULL,
    valid tstzrange NOT NULL,
    reservation_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    CONSTRAINT realm_member_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_member_role_check CHECK ((role = 'member'::text)),
    CONSTRAINT realm_member_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_member_valid_check CHECK ((NOT isempty(valid)))
);


--
-- Name: realm_member_terminal; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_member_terminal (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    account_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    transaction_id uuid NOT NULL,
    at timestamp with time zone NOT NULL,
    CONSTRAINT realm_member_terminal_at_check CHECK (isfinite(at)),
    CONSTRAINT realm_member_terminal_check CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_member_terminal_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: realm_revision; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.realm_revision (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    predecessor uuid,
    title text NOT NULL,
    summary text NOT NULL,
    visibility text NOT NULL,
    context_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    author uuid NOT NULL,
    board_scheme_id uuid,
    votes jsonb DEFAULT '{"upvote": 1, "downvote": -1}'::jsonb NOT NULL,
    CONSTRAINT realm_revision_board_scheme_id_check CHECK (((board_scheme_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)),
    CONSTRAINT realm_revision_check CHECK ((predecessor <> revision_id)),
    CONSTRAINT realm_revision_check1 CHECK ((route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))),
    CONSTRAINT realm_revision_check2 CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT realm_revision_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT realm_revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_revision_summary_check CHECK ((char_length(summary) <= 4096)),
    CONSTRAINT realm_revision_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 1024))),
    CONSTRAINT realm_revision_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'protected'::text]))),
    CONSTRAINT realm_revision_votes_check CHECK (community.realm_votes_allowed(votes))
);


--
-- Name: space; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space (
    route integer NOT NULL,
    space_id uuid NOT NULL,
    state text NOT NULL,
    head_revision_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    creator uuid NOT NULL,
    CONSTRAINT space_check CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT space_check1 CHECK ((route = ((get_byte(uuid_send(head_revision_id), 10) * 256) + get_byte(uuid_send(head_revision_id), 11)))),
    CONSTRAINT space_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_state_check CHECK ((state = 'active'::text))
);


--
-- Name: space_address_claim; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_address_claim (
    route integer NOT NULL,
    normalized_address text NOT NULL COLLATE pg_catalog."C",
    space_id uuid NOT NULL,
    state text NOT NULL,
    expires_at timestamp with time zone,
    reserved_until timestamp with time zone,
    reservation_id uuid,
    transaction_id uuid NOT NULL,
    CONSTRAINT space_address_claim_check CHECK ((route = ((get_byte(sha256(convert_to(normalized_address, 'UTF8'::name)), 0) * 256) + get_byte(sha256(convert_to(normalized_address, 'UTF8'::name)), 1)))),
    CONSTRAINT space_address_claim_check1 CHECK ((((state = 'pending'::text) AND (expires_at IS NOT NULL) AND (reserved_until IS NULL)) OR ((state = 'active'::text) AND (expires_at IS NULL) AND (reserved_until IS NULL)) OR ((state = 'reserved'::text) AND (expires_at IS NULL) AND (reserved_until IS NOT NULL)))),
    CONSTRAINT space_address_claim_normalized_address_check CHECK ((normalized_address ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT space_address_claim_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_address_claim_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'active'::text, 'reserved'::text])))
);


--
-- Name: space_revision; Type: TABLE; Schema: community; Owner: -
--

CREATE TABLE community.space_revision (
    route integer NOT NULL,
    space_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    predecessor uuid,
    title text NOT NULL,
    summary text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    author uuid NOT NULL,
    address text,
    CONSTRAINT space_revision_check CHECK ((predecessor <> revision_id)),
    CONSTRAINT space_revision_check1 CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT space_revision_check2 CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT space_revision_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT space_revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_revision_summary_check CHECK ((char_length(summary) <= 4096)),
    CONSTRAINT space_revision_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 1024)))
);


--
-- Name: publication_head publication_head_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication_head
    ADD CONSTRAINT publication_head_pkey PRIMARY KEY (route, realm_id, subject_id);


--
-- Name: publication publication_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_pkey PRIMARY KEY (route, publication_id);


--
-- Name: publication publication_route_realm_id_publication_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_route_realm_id_publication_id_key UNIQUE (route, realm_id, publication_id);


--
-- Name: realm_ban realm_ban_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_ban
    ADD CONSTRAINT realm_ban_pkey PRIMARY KEY (route, realm_id, account_id, valid WITHOUT OVERLAPS);


--
-- Name: realm_member realm_member_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_member
    ADD CONSTRAINT realm_member_pkey PRIMARY KEY (route, realm_id, account_id, valid WITHOUT OVERLAPS);


--
-- Name: realm_member_terminal realm_member_terminal_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_member_terminal
    ADD CONSTRAINT realm_member_terminal_pkey PRIMARY KEY (route, realm_id, account_id, reservation_id);


--
-- Name: realm realm_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_pkey PRIMARY KEY (route, realm_id);


--
-- Name: realm_revision realm_revision_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_pkey PRIMARY KEY (route, revision_id);


--
-- Name: realm_revision realm_revision_route_realm_id_revision_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_revision_id_key UNIQUE (route, realm_id, revision_id);


--
-- Name: realm_revision realm_revision_route_realm_id_revision_id_visibility_contex_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_revision_id_visibility_contex_key UNIQUE (route, realm_id, revision_id, visibility, context_id);


--
-- Name: realm realm_route_space_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_route_space_id_key UNIQUE (route, space_id);


--
-- Name: space_address_claim space_address_claim_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_address_claim
    ADD CONSTRAINT space_address_claim_pkey PRIMARY KEY (route, normalized_address);


--
-- Name: space space_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space
    ADD CONSTRAINT space_pkey PRIMARY KEY (route, space_id);


--
-- Name: space_revision space_revision_pkey; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_pkey PRIMARY KEY (route, revision_id);


--
-- Name: space_revision space_revision_route_space_id_revision_id_key; Type: CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_route_space_id_revision_id_key UNIQUE (route, space_id, revision_id);


--
-- Name: publication_head_adopted_page; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX publication_head_adopted_page ON community.publication_head USING btree (route, realm_id, published_at DESC, subject_id DESC) WHERE (verdict = 'adopt'::text);


--
-- Name: realm_ban_current; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX realm_ban_current ON community.realm_ban USING btree (route, realm_id, account_id) INCLUDE (valid) WHERE upper_inf(valid);


--
-- Name: realm_member_change; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX realm_member_change ON community.realm_member USING btree (route, realm_id, account_id, transaction_id);


--
-- Name: realm_member_next; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_next ON community.realm_member USING btree (route, realm_id, account_id, lower(valid)) WHERE (NOT lower_inf(valid));


--
-- Name: realm_member_open; Type: INDEX; Schema: community; Owner: -
--

CREATE UNIQUE INDEX realm_member_open ON community.realm_member USING btree (route, realm_id, account_id) WHERE upper_inf(valid);


--
-- Name: realm_member_reservation; Type: INDEX; Schema: community; Owner: -
--

CREATE INDEX realm_member_reservation ON community.realm_member USING btree (route, realm_id, account_id, reservation_id);


--
-- Name: publication_head publication_head_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER publication_head_identity BEFORE UPDATE ON community.publication_head FOR EACH ROW EXECUTE FUNCTION community.guard_publication_head();


--
-- Name: publication publication_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER publication_immutable BEFORE DELETE OR UPDATE ON community.publication FOR EACH ROW EXECUTE FUNCTION community.guard_publication();


--
-- Name: realm realm_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_identity BEFORE UPDATE ON community.realm FOR EACH ROW EXECUTE FUNCTION community.guard_realm();


--
-- Name: realm_member_terminal realm_member_terminal_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_member_terminal_immutable BEFORE DELETE OR UPDATE ON community.realm_member_terminal FOR EACH ROW EXECUTE FUNCTION community.guard_realm_member_terminal();


--
-- Name: realm_revision realm_revision_board_scheme; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_revision_board_scheme BEFORE INSERT ON community.realm_revision FOR EACH ROW WHEN (((new.board_scheme_id IS NULL) AND (new.predecessor IS NOT NULL))) EXECUTE FUNCTION community.inherit_realm_board_scheme();


--
-- Name: realm_revision realm_revision_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_revision_immutable BEFORE DELETE OR UPDATE ON community.realm_revision FOR EACH ROW EXECUTE FUNCTION community.guard_realm_revision();


--
-- Name: realm_revision realm_revision_votes; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER realm_revision_votes BEFORE INSERT ON community.realm_revision FOR EACH ROW WHEN (((new.predecessor IS NOT NULL) AND (new.votes = '{"upvote": 1, "downvote": -1}'::jsonb))) EXECUTE FUNCTION community.inherit_realm_votes();


--
-- Name: space space_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_identity BEFORE UPDATE ON community.space FOR EACH ROW EXECUTE FUNCTION community.guard_space();


--
-- Name: space_revision space_revision_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_revision_immutable BEFORE DELETE OR UPDATE ON community.space_revision FOR EACH ROW EXECUTE FUNCTION community.guard_space_revision();


--
-- Name: publication_head publication_head_route_publication_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication_head
    ADD CONSTRAINT publication_head_route_publication_id_fkey FOREIGN KEY (route, publication_id) REFERENCES community.publication(route, publication_id);


--
-- Name: publication_head publication_head_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication_head
    ADD CONSTRAINT publication_head_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: publication publication_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: publication publication_route_realm_id_predecessor_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.publication
    ADD CONSTRAINT publication_route_realm_id_predecessor_fkey FOREIGN KEY (route, realm_id, predecessor) REFERENCES community.publication(route, realm_id, publication_id);


--
-- Name: realm realm_head_revision_fk; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_head_revision_fk FOREIGN KEY (route, realm_id, head_revision_id, visibility, context_id) REFERENCES community.realm_revision(route, realm_id, revision_id, visibility, context_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: realm_revision realm_revision_route_realm_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_fkey FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: realm_revision realm_revision_route_realm_id_predecessor_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm_revision
    ADD CONSTRAINT realm_revision_route_realm_id_predecessor_fkey FOREIGN KEY (route, realm_id, predecessor) REFERENCES community.realm_revision(route, realm_id, revision_id);


--
-- Name: realm realm_route_space_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.realm
    ADD CONSTRAINT realm_route_space_id_fkey FOREIGN KEY (route, space_id) REFERENCES community.space(route, space_id);


--
-- Name: space space_head_revision_fk; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space
    ADD CONSTRAINT space_head_revision_fk FOREIGN KEY (route, space_id, head_revision_id) REFERENCES community.space_revision(route, space_id, revision_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: space_revision space_revision_route_space_id_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_route_space_id_fkey FOREIGN KEY (route, space_id) REFERENCES community.space(route, space_id);


--
-- Name: space_revision space_revision_route_space_id_predecessor_fkey; Type: FK CONSTRAINT; Schema: community; Owner: -
--

ALTER TABLE ONLY community.space_revision
    ADD CONSTRAINT space_revision_route_space_id_predecessor_fkey FOREIGN KEY (route, space_id, predecessor) REFERENCES community.space_revision(route, space_id, revision_id);


--
-- PostgreSQL database dump complete
--


