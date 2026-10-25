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
-- Name: guard_board_thread(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_board_thread() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.board_id, NEW.thread_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.route, OLD.board_id, OLD.thread_id, OLD.created_at)
     OR ROW(NEW.source_epoch, NEW.source_position) <= ROW(OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Board candidate identity, ordering and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


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
-- Name: guard_imported_field(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_imported_field() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Imported document identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.id, NEW.subject, NEW.candidate, NEW.revision, NEW.body_sha256, NEW.source, NEW.rights,
         NEW.language, NEW.recorded_xid, NEW.recorded_at)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.id, OLD.subject, OLD.candidate, OLD.revision, OLD.body_sha256, OLD.source, OLD.rights,
         OLD.language, OLD.recorded_xid, OLD.recorded_at)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased' OR NEW.body IS NOT NULL THEN
    RAISE EXCEPTION 'Imported documents are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_media_erasure(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_media_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.erased THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Erased media identity must survive cleanup' USING ERRCODE = '23514';
    END IF;
    IF NOT NEW.erased OR
       ROW(NEW.route, NEW.media_id, NEW.container_id, NEW.uploader_id, NEW.key,
           NEW.sha256, NEW.actual_byte_count, NEW.state, NEW.decision)
       IS DISTINCT FROM
       ROW(OLD.route, OLD.media_id, OLD.container_id, OLD.uploader_id, OLD.key,
           OLD.sha256, OLD.actual_byte_count, OLD.state, OLD.decision) THEN
      RAISE EXCEPTION 'Media erasure and exact identity are irreversible' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.erased IS DISTINCT FROM OLD.erased AND NEW.security_revision <= OLD.security_revision THEN
    RAISE EXCEPTION 'Media erasure requires an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_media_security(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_media_security() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.security_revision < OLD.security_revision
     OR (NEW.taken_down IS DISTINCT FROM OLD.taken_down
         AND NEW.security_revision <= OLD.security_revision) THEN
    RAISE EXCEPTION 'Media takedown changes require an increasing security revision'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_operation_identity(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_operation_identity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Operation identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF num_nonnulls(NEW.native_workflow_id, NEW.source_epoch, NEW.source_partition,
        NEW.source_position, NEW.source_event_index) <> 0 THEN
      RAISE EXCEPTION 'Operation source is bound only after recording' USING ERRCODE = '23514';
    END IF;
  ELSIF (to_jsonb(NEW) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index'])
    OR (OLD.native_workflow_id IS NOT NULL AND ROW(NEW.native_workflow_id, NEW.source_epoch,
        NEW.source_partition, NEW.source_position, NEW.source_event_index) IS DISTINCT FROM
      ROW(OLD.native_workflow_id, OLD.source_epoch, OLD.source_partition, OLD.source_position, OLD.source_event_index)) THEN
    RAISE EXCEPTION 'Operation identity and source binding are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_post_erasure(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_post_erasure() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.availability = 'erased' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Erased post identity must survive cleanup' USING ERRCODE = '23514';
    END IF;
    IF NEW.availability <> 'erased' OR NEW.head_revision_id IS DISTINCT FROM OLD.head_revision_id THEN
      RAISE EXCEPTION 'Logical post erasure is irreversible' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.availability IS DISTINCT FROM OLD.availability
     AND NEW.security_revision <= OLD.security_revision THEN
    RAISE EXCEPTION 'Post erasure requires an increasing security revision' USING ERRCODE = '23514';
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
-- Name: guard_source_fence(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_source_fence() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Source fence identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.source, NEW.external_id, NEW.field_group)
      IS DISTINCT FROM ROW(OLD.route, OLD.source, OLD.external_id, OLD.field_group)
    OR NEW.security_revision < OLD.security_revision
    OR (NEW.taken_down IS DISTINCT FROM OLD.taken_down AND NEW.security_revision <= OLD.security_revision) THEN
    RAISE EXCEPTION 'Source fence identity is immutable and changes require an increasing security revision'
      USING ERRCODE = '23514';
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


--
-- Name: operation_scopes_valid(text[]); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.operation_scopes_valid(scopes text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
  SELECT (cardinality(scopes) = 0 OR array_ndims(scopes) = 1)
    AND cardinality(scopes) <= 6450
    AND octet_length(array_to_string(scopes, ' ')) <= 12900
    AND COALESCE(bool_and(scope IS NOT NULL AND scope ~ '^[!-~]{1,128}$'
      AND position('"' in scope) = 0 AND position(chr(92) in scope) = 0), true)
  FROM unnest(scopes) AS scope
$_$;


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
    CONSTRAINT board_title_size CHECK (((char_length(title) >= 1) AND (char_length(title) <= 1024))),
    CONSTRAINT board_visibility_check CHECK ((visibility = ANY (ARRAY['published'::text, 'draft'::text, 'protected'::text, 'taken_down'::text])))
);


--
-- Name: board_thread; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.board_thread (
    route integer NOT NULL,
    board_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    source_revision_id uuid,
    CONSTRAINT board_thread_check CHECK ((route = ((get_byte(uuid_send(board_id), 10) * 256) + get_byte(uuid_send(board_id), 11)))),
    CONSTRAINT board_thread_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT board_thread_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT board_thread_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT board_thread_source_position_check CHECK ((source_position > 0))
);


--
-- Name: imported_field; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.imported_field (
    route integer NOT NULL,
    id uuid NOT NULL,
    subject uuid NOT NULL,
    candidate uuid NOT NULL,
    revision bigint NOT NULL,
    body bytea,
    body_sha256 bytea NOT NULL,
    source jsonb NOT NULL,
    rights jsonb NOT NULL,
    language text NOT NULL,
    availability text NOT NULL,
    recorded_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    recorded_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT imported_field_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'erased'::text]))),
    CONSTRAINT imported_field_body_digest CHECK ((body_sha256 = sha256(body))),
    CONSTRAINT imported_field_body_sha256_check CHECK ((octet_length(body_sha256) = 32)),
    CONSTRAINT imported_field_body_size CHECK ((octet_length(body) <= 2097152)),
    CONSTRAINT imported_field_check CHECK ((route = ((get_byte(uuid_send(id), 10) * 256) + get_byte(uuid_send(id), 11)))),
    CONSTRAINT imported_field_check1 CHECK ((route = ((get_byte(uuid_send(subject), 10) * 256) + get_byte(uuid_send(subject), 11)))),
    CONSTRAINT imported_field_check2 CHECK ((route = ((get_byte(uuid_send(candidate), 10) * 256) + get_byte(uuid_send(candidate), 11)))),
    CONSTRAINT imported_field_check3 CHECK ((((availability = 'available'::text) AND (body IS NOT NULL)) OR ((availability = 'erased'::text) AND (body IS NULL)))),
    CONSTRAINT imported_field_language_check CHECK (((length(language) >= 1) AND (length(language) <= 128))),
    CONSTRAINT imported_field_metadata_size CHECK (((octet_length(convert_to((source)::text, 'UTF8'::name)) <= 65536) AND (octet_length(convert_to((rights)::text, 'UTF8'::name)) <= 8192) AND ((char_length((rights ->> 'license'::text)) >= 1) AND (char_length((rights ->> 'license'::text)) <= 128)) AND (((rights ->> 'license'::text) ~ '^[A-Za-z0-9.+-]+$'::text) OR ((rights ->> 'license'::text) ~ '^LicenseRef-[A-Za-z0-9.-]+$'::text)) AND ((char_length((rights ->> 'attribution'::text)) >= 1) AND (char_length((rights ->> 'attribution'::text)) <= 1024)) AND (jsonb_typeof((rights -> 'obligations'::text)) = 'array'::text))),
    CONSTRAINT imported_field_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT imported_field_rights_check CHECK ((jsonb_typeof(rights) = 'object'::text)),
    CONSTRAINT imported_field_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT imported_field_source_check CHECK ((jsonb_typeof(source) = 'object'::text)),
    CONSTRAINT imported_field_source_check1 CHECK ((NOT ((source ->> 'field_group'::text) IS DISTINCT FROM 'summary'::text))),
    CONSTRAINT imported_field_source_check2 CHECK (((source ? 'references'::text) AND (jsonb_typeof((source -> 'references'::text)) = 'array'::text) AND (jsonb_array_length((source -> 'references'::text)) <= 128)))
);
ALTER TABLE ONLY content.imported_field ALTER COLUMN body SET COMPRESSION lz4;


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
    media_type text,
    byte_count bigint,
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
    source_url text,
    credit jsonb,
    provenance jsonb,
    taken_down boolean DEFAULT false NOT NULL,
    security_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT media_actual_byte_count_check CHECK (((actual_byte_count IS NULL) OR (actual_byte_count > 0))),
    CONSTRAINT media_byte_count_check CHECK (((byte_count >= 1) AND (byte_count <= 20971520))),
    CONSTRAINT media_check CHECK ((route = ((get_byte(uuid_send(media_id), 10) * 256) + get_byte(uuid_send(media_id), 11)))),
    CONSTRAINT media_check1 CHECK ((route = ((get_byte(uuid_send(container_id), 10) * 256) + get_byte(uuid_send(container_id), 11)))),
    CONSTRAINT media_check2 CHECK ((key = (('m/'::text || (media_id)::text) || '/original'::text))),
    CONSTRAINT media_check3 CHECK (((sha256 IS NULL) OR (declared_sha256 IS NULL) OR (sha256 = declared_sha256))),
    CONSTRAINT media_check5 CHECK (((claimed_at IS NULL) OR (state = 'available'::text))),
    CONSTRAINT media_check6 CHECK (((NOT collection_pending) OR (claimed_at IS NULL))),
    CONSTRAINT media_check7 CHECK ((NOT (collection_pending AND erased))),
    CONSTRAINT media_cover_metadata_size CHECK (((purpose <> 'cover'::text) OR (((char_length(source_url) >= 1) AND (char_length(source_url) <= 2048)) AND (octet_length(convert_to((credit)::text, 'UTF8'::name)) <= 8192) AND ((char_length((credit ->> 'rightsHolder'::text)) >= 1) AND (char_length((credit ->> 'rightsHolder'::text)) <= 1024)) AND ((char_length(((credit -> 'via'::text) ->> 'name'::text)) >= 1) AND (char_length(((credit -> 'via'::text) ->> 'name'::text)) <= 1024)) AND ((char_length(((credit -> 'via'::text) ->> 'url'::text)) >= 1) AND (char_length(((credit -> 'via'::text) ->> 'url'::text)) <= 2048)) AND ((char_length((credit ->> 'license'::text)) >= 1) AND (char_length((credit ->> 'license'::text)) <= 128)) AND (((credit ->> 'license'::text) ~ '^[A-Za-z0-9.+-]+$'::text) OR ((credit ->> 'license'::text) ~ '^LicenseRef-[A-Za-z0-9.-]+$'::text)) AND (octet_length(convert_to((provenance)::text, 'UTF8'::name)) <= 65536) AND ((jsonb_array_length((provenance -> 'references'::text)) >= 1) AND (jsonb_array_length((provenance -> 'references'::text)) <= 128))))),
    CONSTRAINT media_cover_provenance_check CHECK (((purpose <> 'cover'::text) OR (((source_url IS NOT NULL) AND (source_url ~ '^https://[^[:space:]]+$'::text) AND (char_length(source_url) <= 2048) AND (credit IS NOT NULL) AND (jsonb_typeof(credit) = 'object'::text) AND (jsonb_typeof((credit -> 'rightsHolder'::text)) = 'string'::text) AND ((char_length((credit ->> 'rightsHolder'::text)) >= 1) AND (char_length((credit ->> 'rightsHolder'::text)) <= 1024)) AND (jsonb_typeof((credit -> 'via'::text)) = 'object'::text) AND (jsonb_typeof(((credit -> 'via'::text) -> 'name'::text)) = 'string'::text) AND ((char_length(((credit -> 'via'::text) ->> 'name'::text)) >= 1) AND (char_length(((credit -> 'via'::text) ->> 'name'::text)) <= 1024)) AND (((credit -> 'via'::text) ->> 'url'::text) ~ '^https://[^[:space:]]+$'::text) AND (jsonb_typeof((credit -> 'license'::text)) = 'string'::text) AND (char_length((credit ->> 'license'::text)) > 0) AND (jsonb_typeof((credit -> 'obligations'::text)) = 'array'::text) AND (provenance IS NOT NULL) AND (jsonb_typeof(provenance) = 'object'::text) AND ((provenance ->> 'source'::text) ~ '^[a-z][a-z0-9_-]{0,31}$'::text) AND (char_length((provenance ->> 'external_id'::text)) > 0) AND (char_length((provenance ->> 'record_revision'::text)) > 0) AND ((provenance ->> 'digest'::text) ~ '^[0-9a-f]{64}$'::text) AND (char_length((provenance ->> 'converter_revision'::text)) > 0) AND ((provenance ->> 'field_group'::text) = 'cover'::text) AND (jsonb_typeof((provenance -> 'references'::text)) = 'array'::text) AND ((jsonb_array_length((provenance -> 'references'::text)) >= 1) AND (jsonb_array_length((provenance -> 'references'::text)) <= 128))) IS TRUE))),
    CONSTRAINT media_decision_check CHECK (((decision IS NULL) OR (char_length(decision) > 0))),
    CONSTRAINT media_declared_measurements_check CHECK (((purpose = 'cover'::text) OR ((byte_count IS NOT NULL) AND (media_type IS NOT NULL)))),
    CONSTRAINT media_declared_sha256_check CHECK ((declared_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_measurements_check CHECK (((((state = 'reserved'::text) AND (actual_byte_count IS NULL) AND (sha256 IS NULL) AND (decision IS NULL) AND (claimed_at IS NULL)) OR ((state = ANY (ARRAY['uploaded'::text, 'available'::text, 'rejected'::text])) AND (byte_count IS NOT NULL) AND (media_type IS NOT NULL) AND (actual_byte_count IS NOT NULL) AND (actual_byte_count = byte_count) AND (sha256 IS NOT NULL) AND (((state = 'uploaded'::text) AND (decision IS NULL) AND (claimed_at IS NULL)) OR ((state = 'available'::text) AND (decision IS NULL)) OR ((state = 'rejected'::text) AND (decision IS NOT NULL) AND (claimed_at IS NULL)))) OR ((purpose = 'cover'::text) AND (state = 'rejected'::text) AND (byte_count IS NULL) AND (media_type IS NULL) AND (actual_byte_count IS NULL) AND (sha256 IS NULL) AND (declared_sha256 IS NULL) AND (decision IS NOT NULL) AND (claimed_at IS NULL))) IS TRUE)),
    CONSTRAINT media_media_type_check CHECK ((media_type = ANY (ARRAY['image/avif'::text, 'image/gif'::text, 'image/jpeg'::text, 'image/png'::text, 'image/webp'::text]))),
    CONSTRAINT media_purpose_check CHECK ((purpose = ANY (ARRAY['post-image'::text, 'cover'::text]))),
    CONSTRAINT media_reservation_request_id_check CHECK (((char_length(reservation_request_id) >= 1) AND (char_length(reservation_request_id) <= 255))),
    CONSTRAINT media_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT media_security_revision_check CHECK ((security_revision >= 0)),
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
-- Name: operation; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.operation (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    initiator_account_id uuid NOT NULL,
    author_account_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_account_id uuid NOT NULL,
    actor_client_id text NOT NULL,
    actor_scopes text[] NOT NULL,
    actor_requested_by text,
    actor_authn_epoch bigint NOT NULL,
    empty_scope boolean NOT NULL,
    upper_created_at timestamp with time zone,
    upper_post_id uuid,
    requested_at timestamp with time zone NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    native_workflow_id text,
    source_epoch integer,
    source_partition integer,
    source_position bigint,
    source_event_index integer,
    CONSTRAINT operation_actor_authn_epoch_check CHECK (((actor_authn_epoch >= 1) AND (actor_authn_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT operation_actor_client_id_check CHECK (((char_length(actor_client_id) >= 1) AND (char_length(actor_client_id) <= 1024))),
    CONSTRAINT operation_actor_kind_check CHECK ((actor_kind = 'account'::text)),
    CONSTRAINT operation_actor_requested_by_check CHECK ((actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)),
    CONSTRAINT operation_actor_scopes_check CHECK (content.operation_scopes_valid(actor_scopes)),
    CONSTRAINT operation_check CHECK ((actor_account_id = initiator_account_id)),
    CONSTRAINT operation_check1 CHECK ((route = ((get_byte(uuid_send(operation_id), 10) * 256) + get_byte(uuid_send(operation_id), 11)))),
    CONSTRAINT operation_check2 CHECK (((route >> 4) = (((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)) >> 4))),
    CONSTRAINT operation_check3 CHECK (((empty_scope AND (upper_created_at IS NULL) AND (upper_post_id IS NULL)) OR ((NOT empty_scope) AND (upper_created_at IS NOT NULL) AND (upper_post_id IS NOT NULL) AND isfinite(upper_created_at) AND (upper_created_at <= requested_at) AND (SUBSTRING(uuid_send(upper_post_id) FROM 11 FOR 2) = SUBSTRING(uuid_send(thread_id) FROM 11 FOR 2))))),
    CONSTRAINT operation_check4 CHECK (((num_nonnulls(native_workflow_id, source_epoch, source_partition, source_position, source_event_index) = 0) OR ((num_nonnulls(native_workflow_id, source_epoch, source_partition, source_position, source_event_index) = 5) AND (source_epoch > 0) AND (source_partition = (route >> 4)) AND (source_position > 0) AND (source_event_index >= 0) AND (native_workflow_id = ((((((((('fx:'::text || source_epoch) || ':'::text) || source_partition) || ':'::text) || source_position) || ':'::text) || source_event_index) || ':content_author_erase_'::text) || operation_id))))),
    CONSTRAINT operation_requested_at_check CHECK (isfinite(requested_at)),
    CONSTRAINT operation_route_check CHECK (((route >= 0) AND (route <= 65535)))
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
    CONSTRAINT revision_licence_size CHECK ((((char_length(licence) >= 1) AND (char_length(licence) <= 128)) AND ((licence ~ '^[A-Za-z0-9.+-]+$'::text) OR (licence ~ '^LicenseRef-[A-Za-z0-9.-]+$'::text)))),
    CONSTRAINT revision_media_ids_limit CHECK ((cardinality(media_ids) <= 32)),
    CONSTRAINT revision_media_routes_check CHECK (content.media_routes_match(route, media_ids)),
    CONSTRAINT revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT revision_subject_ids_limit CHECK ((cardinality(subject_ids) <= 128))
);
ALTER TABLE ONLY content.revision ALTER COLUMN body SET COMPRESSION lz4;


--
-- Name: source_fences; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.source_fences (
    route integer NOT NULL,
    source text NOT NULL COLLATE pg_catalog."C",
    external_id text NOT NULL COLLATE pg_catalog."C",
    field_group text NOT NULL COLLATE pg_catalog."C",
    taken_down boolean NOT NULL,
    security_revision bigint NOT NULL,
    CONSTRAINT source_fences_external_id_check CHECK ((((octet_length(external_id) >= 1) AND (octet_length(external_id) <= 1024)) AND (external_id !~ '[\u0001-\u001f\u007f-\u009f]'::text))),
    CONSTRAINT source_fences_field_group_check CHECK ((field_group = ANY (ARRAY['facts'::text, 'summary'::text, 'cover'::text]))),
    CONSTRAINT source_fences_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT source_fences_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT source_fences_source_check CHECK ((source ~ '^[a-z][a-z0-9_-]{0,31}$'::text))
);


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
    CONSTRAINT thread_title_size CHECK (((title IS NULL) OR ((char_length(title) >= 1) AND (char_length(title) <= 1024)))),
    CONSTRAINT thread_visibility_check CHECK ((visibility = ANY (ARRAY['published'::text, 'draft'::text, 'protected'::text, 'taken_down'::text])))
);


--
-- Name: board board_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board
    ADD CONSTRAINT board_pkey PRIMARY KEY (route, board_id);


--
-- Name: board_thread board_thread_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_thread
    ADD CONSTRAINT board_thread_pkey PRIMARY KEY (route, board_id, thread_id);


--
-- Name: imported_field imported_field_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.imported_field
    ADD CONSTRAINT imported_field_pkey PRIMARY KEY (route, id);


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
-- Name: operation operation_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.operation
    ADD CONSTRAINT operation_pkey PRIMARY KEY (route, operation_id);


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
-- Name: source_fences source_fences_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.source_fences
    ADD CONSTRAINT source_fences_pkey PRIMARY KEY (route, source, external_id, field_group);


--
-- Name: thread thread_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.thread
    ADD CONSTRAINT thread_pkey PRIMARY KEY (route, thread_id);


--
-- Name: board_thread_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_thread_page_idx ON content.board_thread USING btree (route, board_id, created_at, thread_id);


--
-- Name: media_collection_eligible_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX media_collection_eligible_idx ON content.media USING btree (route, created_at, media_id) WHERE ((claimed_at IS NULL) AND (NOT erased) AND (NOT collection_pending));


--
-- Name: media_collection_pending_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX media_collection_pending_idx ON content.media USING btree (route, created_at, media_id) WHERE collection_pending;


--
-- Name: media_cover_reference_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX media_cover_reference_idx ON content.media USING btree (route, media_id) WHERE ((purpose = 'cover'::text) AND (state = 'available'::text) AND (NOT erased) AND (NOT collection_pending) AND (NOT taken_down));


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
-- Name: board_thread board_thread_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER board_thread_identity BEFORE UPDATE ON content.board_thread FOR EACH ROW EXECUTE FUNCTION content.guard_board_thread();


--
-- Name: imported_field imported_field_immutable; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER imported_field_immutable BEFORE DELETE OR UPDATE ON content.imported_field FOR EACH ROW EXECUTE FUNCTION content.guard_imported_field();


--
-- Name: media media_erasure_guard; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER media_erasure_guard BEFORE DELETE OR UPDATE ON content.media FOR EACH ROW EXECUTE FUNCTION content.guard_media_erasure();


--
-- Name: media media_security_guard; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER media_security_guard BEFORE UPDATE ON content.media FOR EACH ROW EXECUTE FUNCTION content.guard_media_security();


--
-- Name: operation operation_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER operation_identity BEFORE INSERT OR DELETE OR UPDATE ON content.operation FOR EACH ROW EXECUTE FUNCTION content.guard_operation_identity();


--
-- Name: post post_erasure_guard; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER post_erasure_guard BEFORE DELETE OR UPDATE ON content.post FOR EACH ROW EXECUTE FUNCTION content.guard_post_erasure();


--
-- Name: post post_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER post_identity BEFORE UPDATE ON content.post FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'post_id', 'reply_to_post_id', 'author_account_id', 'created_at');


--
-- Name: revision revision_immutable; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER revision_immutable BEFORE DELETE OR UPDATE ON content.revision FOR EACH ROW EXECUTE FUNCTION content.guard_revision();


--
-- Name: source_fences source_fence_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER source_fence_identity BEFORE DELETE OR UPDATE ON content.source_fences FOR EACH ROW EXECUTE FUNCTION content.guard_source_fence();


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


