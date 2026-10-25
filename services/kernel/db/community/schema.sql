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


SET default_tablespace = '';

SET default_table_access_method = heap;

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
    CONSTRAINT space_revision_check CHECK ((predecessor <> revision_id)),
    CONSTRAINT space_revision_check1 CHECK ((route = ((get_byte(uuid_send(space_id), 10) * 256) + get_byte(uuid_send(space_id), 11)))),
    CONSTRAINT space_revision_check2 CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT space_revision_check3 CHECK ((route = ((get_byte(uuid_send(predecessor), 10) * 256) + get_byte(uuid_send(predecessor), 11)))),
    CONSTRAINT space_revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT space_revision_summary_check CHECK ((char_length(summary) <= 4096)),
    CONSTRAINT space_revision_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 1024)))
);


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
-- Name: space space_identity; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_identity BEFORE UPDATE ON community.space FOR EACH ROW EXECUTE FUNCTION community.guard_space();


--
-- Name: space_revision space_revision_immutable; Type: TRIGGER; Schema: community; Owner: -
--

CREATE TRIGGER space_revision_immutable BEFORE DELETE OR UPDATE ON community.space_revision FOR EACH ROW EXECUTE FUNCTION community.guard_space_revision();


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


