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
         NEW.licence, NEW.subject_ids, NEW.board_id, NEW.recorded_transaction_id, NEW.recorded_at, NEW.media_ids)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.thread_id, OLD.post_id, OLD.revision_id, OLD.body_sha256,
         OLD.licence, OLD.subject_ids, OLD.board_id, OLD.recorded_transaction_id, OLD.recorded_at, OLD.media_ids)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased'
     OR NEW.body IS NOT NULL OR NEW.search_text IS NOT NULL THEN
    RAISE EXCEPTION 'Revisions are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: media_routes_match(integer, uuid[]); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.media_routes_match(route integer, media_ids uuid[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$
  SELECT COALESCE(bool_and(media_id IS NOT NULL AND
    route = get_byte(uuid_send(media_id), 10) * 256 + get_byte(uuid_send(media_id), 11)), true)
  FROM unnest(media_ids) AS media_id
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
    created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT board_check CHECK ((route = ((get_byte(uuid_send(board_id), 10) * 256) + get_byte(uuid_send(board_id), 11)))),
    CONSTRAINT board_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT board_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT board_visibility_check CHECK ((visibility = ANY (ARRAY['published'::text, 'draft'::text, 'protected'::text, 'taken_down'::text])))
);


--
-- Name: media; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.media (
    route integer NOT NULL,
    media_id uuid NOT NULL,
    container_id uuid NOT NULL,
    uploader_id uuid NOT NULL,
    reservation_request_id text NOT NULL,
    purpose text NOT NULL,
    media_type text NOT NULL,
    byte_count bigint NOT NULL,
    declared_sha256 text,
    actual_byte_count bigint,
    sha256 text,
    state text NOT NULL,
    decision text,
    key text NOT NULL,
    claimed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    transaction_id uuid NOT NULL,
    erased boolean DEFAULT false NOT NULL,
    collection_pending boolean DEFAULT false NOT NULL,
    CONSTRAINT media_actual_byte_count_check CHECK (((actual_byte_count IS NULL) OR (actual_byte_count > 0))),
    CONSTRAINT media_byte_count_check CHECK (((byte_count >= 1) AND (byte_count <= 20971520))),
    CONSTRAINT media_check CHECK ((route = ((get_byte(uuid_send(media_id), 10) * 256) + get_byte(uuid_send(media_id), 11)))),
    CONSTRAINT media_check1 CHECK ((route = ((get_byte(uuid_send(container_id), 10) * 256) + get_byte(uuid_send(container_id), 11)))),
    CONSTRAINT media_check2 CHECK ((key = (('m/'::text || (media_id)::text) || '/original'::text))),
    CONSTRAINT media_check3 CHECK (((sha256 IS NULL) OR (declared_sha256 IS NULL) OR (sha256 = declared_sha256))),
    CONSTRAINT media_check4 CHECK ((((state = 'reserved'::text) AND (actual_byte_count IS NULL) AND (sha256 IS NULL) AND (decision IS NULL) AND (claimed_at IS NULL)) OR ((state = 'uploaded'::text) AND (actual_byte_count = byte_count) AND (sha256 IS NOT NULL) AND (decision IS NULL) AND (claimed_at IS NULL)) OR ((state = 'available'::text) AND (actual_byte_count = byte_count) AND (sha256 IS NOT NULL) AND (decision IS NULL)) OR ((state = 'rejected'::text) AND (actual_byte_count = byte_count) AND (sha256 IS NOT NULL) AND (decision IS NOT NULL) AND (claimed_at IS NULL)))),
    CONSTRAINT media_check5 CHECK (((claimed_at IS NULL) OR (state = 'available'::text))),
    CONSTRAINT media_check6 CHECK (((NOT collection_pending) OR (claimed_at IS NULL))),
    CONSTRAINT media_check7 CHECK ((NOT (collection_pending AND erased))),
    CONSTRAINT media_decision_check CHECK (((decision IS NULL) OR (char_length(decision) > 0))),
    CONSTRAINT media_declared_sha256_check CHECK ((declared_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_media_type_check CHECK ((media_type = ANY (ARRAY['image/avif'::text, 'image/gif'::text, 'image/jpeg'::text, 'image/png'::text, 'image/webp'::text]))),
    CONSTRAINT media_purpose_check CHECK ((purpose = 'post-image'::text)),
    CONSTRAINT media_reservation_request_id_check CHECK (((char_length(reservation_request_id) >= 1) AND (char_length(reservation_request_id) <= 255))),
    CONSTRAINT media_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT media_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'uploaded'::text, 'available'::text, 'rejected'::text])))
);


--
-- Name: media_variant; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.media_variant (
    route integer NOT NULL,
    media_id uuid NOT NULL,
    format text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    media_type text NOT NULL,
    byte_count bigint NOT NULL,
    sha256 text NOT NULL,
    key text NOT NULL,
    transaction_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT statement_timestamp() NOT NULL,
    CONSTRAINT media_variant_byte_count_check CHECK ((byte_count > 0)),
    CONSTRAINT media_variant_check CHECK ((((format = 'avif'::text) AND (media_type = 'image/avif'::text)) OR ((format = 'webp'::text) AND (media_type = 'image/webp'::text)))),
    CONSTRAINT media_variant_check1 CHECK ((key = ((((('m/'::text || (media_id)::text) || '/'::text) || format) || '-'::text) || (width)::text))),
    CONSTRAINT media_variant_format_check CHECK ((format = ANY (ARRAY['avif'::text, 'webp'::text]))),
    CONSTRAINT media_variant_height_check CHECK ((height > 0)),
    CONSTRAINT media_variant_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT media_variant_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_variant_width_check CHECK (((width >= 1) AND (width <= 2560))),
    CONSTRAINT media_variant_width_ladder_check CHECK (((width < 320) OR (width = ANY (ARRAY[320, 640, 960, 1280, 1920, 2560]))))
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
    created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    availability text DEFAULT 'available'::text NOT NULL,
    CONSTRAINT post_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'erased'::text]))),
    CONSTRAINT post_check CHECK ((route = ((get_byte(uuid_send(post_id), 10) * 256) + get_byte(uuid_send(post_id), 11)))),
    CONSTRAINT post_check1 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT post_check2 CHECK ((route = ((get_byte(uuid_send(reply_to_post_id), 10) * 256) + get_byte(uuid_send(reply_to_post_id), 11)))),
    CONSTRAINT post_check3 CHECK ((route = ((get_byte(uuid_send(head_revision_id), 10) * 256) + get_byte(uuid_send(head_revision_id), 11)))),
    CONSTRAINT post_check4 CHECK ((reply_to_post_id <> post_id)),
    CONSTRAINT post_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT post_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT post_visibility_check CHECK ((visibility = ANY (ARRAY['published'::text, 'draft'::text, 'protected'::text, 'taken_down'::text])))
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
    media_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    CONSTRAINT revision_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'erased'::text]))),
    CONSTRAINT revision_body_sha256_check CHECK ((octet_length(body_sha256) = 32)),
    CONSTRAINT revision_body_sha256_matches CHECK ((body_sha256 = sha256(body))),
    CONSTRAINT revision_body_size_limit CHECK ((octet_length(body) <= 2097152)),
    CONSTRAINT revision_check CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT revision_check1 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT revision_check2 CHECK ((route = ((get_byte(uuid_send(post_id), 10) * 256) + get_byte(uuid_send(post_id), 11)))),
    CONSTRAINT revision_check3 CHECK ((((availability = 'erased'::text) AND (body IS NULL) AND (search_text IS NULL)) OR ((availability = 'available'::text) AND (body IS NOT NULL) AND (search_text IS NOT NULL)))),
    CONSTRAINT revision_media_ids_limit CHECK ((cardinality(media_ids) <= 32)),
    CONSTRAINT revision_media_routes_check CHECK (content.media_routes_match(route, media_ids)),
    CONSTRAINT revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT revision_subject_ids_limit CHECK ((cardinality(subject_ids) <= 128))
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
    title text,
    visibility text NOT NULL,
    security_revision bigint NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    first_post_id uuid,
    availability text DEFAULT 'available'::text NOT NULL,
    CONSTRAINT thread_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'erased'::text]))),
    CONSTRAINT thread_check CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT thread_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT thread_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT thread_visibility_check CHECK ((visibility = ANY (ARRAY['published'::text, 'draft'::text, 'protected'::text, 'taken_down'::text])))
);


--
-- Name: board board_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board
    ADD CONSTRAINT board_pkey PRIMARY KEY (route, board_id);


--
-- Name: media media_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (route, media_id);


--
-- Name: media media_route_key_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.media
    ADD CONSTRAINT media_route_key_key UNIQUE (route, key);


--
-- Name: media media_route_uploader_id_reservation_request_id_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.media
    ADD CONSTRAINT media_route_uploader_id_reservation_request_id_key UNIQUE (route, uploader_id, reservation_request_id);


--
-- Name: media_variant media_variant_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.media_variant
    ADD CONSTRAINT media_variant_pkey PRIMARY KEY (route, media_id, format, width);


--
-- Name: media_variant media_variant_route_key_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.media_variant
    ADD CONSTRAINT media_variant_route_key_key UNIQUE (route, key);


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
-- Name: media_collection_eligible_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX media_collection_eligible_idx ON content.media USING btree (route, created_at, media_id) WHERE ((claimed_at IS NULL) AND (NOT erased) AND (NOT collection_pending));


--
-- Name: media_collection_pending_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX media_collection_pending_idx ON content.media USING btree (route, created_at, media_id) WHERE collection_pending;


--
-- Name: media_variant_slot_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE UNIQUE INDEX media_variant_slot_idx ON content.media_variant USING btree (route, media_id, ((
CASE format
    WHEN 'avif'::text THEN 0
    ELSE 6
END +
CASE
    WHEN (width < 320) THEN 1
    ELSE array_position(ARRAY[320, 640, 960, 1280, 1920, 2560], width)
END)));


--
-- Name: post_thread_author_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX post_thread_author_page_idx ON content.post USING btree (route, thread_id, author_account_id, created_at, post_id);


--
-- Name: post_thread_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX post_thread_page_idx ON content.post USING btree (route, thread_id, created_at, post_id);


--
-- Name: revision_post_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX revision_post_page_idx ON content.revision USING btree (route, post_id, recorded_at, revision_id);


--
-- Name: board board_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER board_identity BEFORE UPDATE ON content.board FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'board_id', 'subject_id', 'created_at');


--
-- Name: post post_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER post_identity BEFORE UPDATE ON content.post FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'post_id', 'reply_to_post_id', 'author_account_id', 'created_at');


--
-- Name: revision revision_immutable; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER revision_immutable BEFORE DELETE OR UPDATE ON content.revision FOR EACH ROW EXECUTE FUNCTION content.guard_revision();


--
-- Name: thread thread_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER thread_identity BEFORE UPDATE ON content.thread FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'author_account_id', 'created_at');


--
-- Name: media_variant media_variant_route_media_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.media_variant
    ADD CONSTRAINT media_variant_route_media_id_fkey FOREIGN KEY (route, media_id) REFERENCES content.media(route, media_id) ON DELETE CASCADE;


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
-- Name: thread thread_first_post_fk; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.thread
    ADD CONSTRAINT thread_first_post_fk FOREIGN KEY (route, thread_id, first_post_id) REFERENCES content.post(route, thread_id, post_id) DEFERRABLE INITIALLY DEFERRED;


--
-- PostgreSQL database dump complete
--


