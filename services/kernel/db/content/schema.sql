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
-- Name: content; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA content;


--
-- Name: guard_identity(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  column_name text;
BEGIN
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    IF to_jsonb(NEW) -> column_name IS DISTINCT FROM to_jsonb(OLD) -> column_name THEN
      RAISE EXCEPTION 'Content identity and containment are immutable' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NEW.security_revision < OLD.security_revision
     OR (NEW.visibility IS DISTINCT FROM OLD.visibility AND NEW.security_revision <= OLD.security_revision) THEN
    RAISE EXCEPTION 'Visibility changes require an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_revision(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Revision identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.thread_id, NEW.post_id, NEW.revision_id, NEW.body_sha256,
         NEW.licence, NEW.subject_ids, NEW.board_id, NEW.recorded_transaction_id, NEW.recorded_at)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.thread_id, OLD.post_id, OLD.revision_id, OLD.body_sha256,
         OLD.licence, OLD.subject_ids, OLD.board_id, OLD.recorded_transaction_id, OLD.recorded_at)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased'
     OR NEW.body IS NOT NULL OR NEW.search_text IS NOT NULL THEN
    RAISE EXCEPTION 'Revisions are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: board; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.board (
    route integer NOT NULL,
    board_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    title text NOT NULL,
    visibility text NOT NULL,
    security_revision bigint NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT board_check CHECK ((route = ((get_byte(uuid_send(board_id), 10) * 256) + get_byte(uuid_send(board_id), 11)))),
    CONSTRAINT board_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT board_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT board_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text, 'taken_down'::text])))
);


--
-- Name: post; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.post (
    route integer NOT NULL,
    thread_id uuid NOT NULL,
    post_id uuid NOT NULL,
    reply_to_post_id uuid,
    author_account_id uuid NOT NULL,
    head_revision_id uuid NOT NULL,
    visibility text NOT NULL,
    security_revision bigint NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT post_check CHECK ((route = ((get_byte(uuid_send(post_id), 10) * 256) + get_byte(uuid_send(post_id), 11)))),
    CONSTRAINT post_check1 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT post_check2 CHECK ((route = ((get_byte(uuid_send(reply_to_post_id), 10) * 256) + get_byte(uuid_send(reply_to_post_id), 11)))),
    CONSTRAINT post_check3 CHECK ((route = ((get_byte(uuid_send(head_revision_id), 10) * 256) + get_byte(uuid_send(head_revision_id), 11)))),
    CONSTRAINT post_check4 CHECK ((reply_to_post_id <> post_id)),
    CONSTRAINT post_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT post_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT post_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text, 'taken_down'::text])))
);


--
-- Name: revision; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.revision (
    route integer NOT NULL,
    thread_id uuid NOT NULL,
    post_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    body bytea,
    body_sha256 bytea NOT NULL,
    search_text text,
    licence text NOT NULL,
    subject_ids uuid[] NOT NULL,
    board_id uuid NOT NULL,
    availability text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    recorded_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT revision_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'erased'::text]))),
    CONSTRAINT revision_body_sha256_check CHECK ((octet_length(body_sha256) = 32)),
    CONSTRAINT revision_body_sha256_matches CHECK ((body_sha256 = sha256(body))),
    CONSTRAINT revision_body_size_limit CHECK ((octet_length(body) <= 2097152)),
    CONSTRAINT revision_check CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT revision_check1 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT revision_check2 CHECK ((route = ((get_byte(uuid_send(post_id), 10) * 256) + get_byte(uuid_send(post_id), 11)))),
    CONSTRAINT revision_check3 CHECK ((((availability = 'erased'::text) AND (body IS NULL) AND (search_text IS NULL)) OR ((availability = 'available'::text) AND (body IS NOT NULL) AND (search_text IS NOT NULL)))),
    CONSTRAINT revision_route_check CHECK (((route >= 0) AND (route <= 65535)))
);
ALTER TABLE ONLY content.revision ALTER COLUMN body SET COMPRESSION lz4;


--
-- Name: thread; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.thread (
    route integer NOT NULL,
    thread_id uuid NOT NULL,
    author_account_id uuid NOT NULL,
    board_id uuid NOT NULL,
    title text NOT NULL,
    visibility text NOT NULL,
    security_revision bigint NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    CONSTRAINT thread_check CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT thread_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT thread_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT thread_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'private'::text, 'taken_down'::text])))
);


--
-- Name: board board_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board
    ADD CONSTRAINT board_pkey PRIMARY KEY (route, board_id);


--
-- Name: post post_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.post
    ADD CONSTRAINT post_pkey PRIMARY KEY (route, post_id);


--
-- Name: post post_route_thread_id_post_id_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.post
    ADD CONSTRAINT post_route_thread_id_post_id_key UNIQUE (route, thread_id, post_id);


--
-- Name: revision revision_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.revision
    ADD CONSTRAINT revision_pkey PRIMARY KEY (route, revision_id);


--
-- Name: revision revision_route_thread_id_post_id_revision_id_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.revision
    ADD CONSTRAINT revision_route_thread_id_post_id_revision_id_key UNIQUE (route, thread_id, post_id, revision_id);


--
-- Name: thread thread_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.thread
    ADD CONSTRAINT thread_pkey PRIMARY KEY (route, thread_id);


--
-- Name: board board_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER board_identity BEFORE UPDATE ON content.board FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'board_id', 'subject_id');


--
-- Name: post post_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER post_identity BEFORE UPDATE ON content.post FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'post_id', 'reply_to_post_id', 'author_account_id');


--
-- Name: revision revision_immutable; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER revision_immutable BEFORE DELETE OR UPDATE ON content.revision FOR EACH ROW EXECUTE FUNCTION content.guard_revision();


--
-- Name: thread thread_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER thread_identity BEFORE UPDATE ON content.thread FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'author_account_id');


--
-- Name: post post_head_revision_fk; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.post
    ADD CONSTRAINT post_head_revision_fk FOREIGN KEY (route, thread_id, post_id, head_revision_id) REFERENCES content.revision(route, thread_id, post_id, revision_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: post post_route_thread_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.post
    ADD CONSTRAINT post_route_thread_id_fkey FOREIGN KEY (route, thread_id) REFERENCES content.thread(route, thread_id);


--
-- Name: post post_route_thread_id_reply_to_post_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.post
    ADD CONSTRAINT post_route_thread_id_reply_to_post_id_fkey FOREIGN KEY (route, thread_id, reply_to_post_id) REFERENCES content.post(route, thread_id, post_id);


--
-- Name: revision revision_route_thread_id_post_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.revision
    ADD CONSTRAINT revision_route_thread_id_post_id_fkey FOREIGN KEY (route, thread_id, post_id) REFERENCES content.post(route, thread_id, post_id);


--
-- PostgreSQL database dump complete
--


