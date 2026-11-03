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
-- Name: board_thread_active_rank(integer, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.board_thread_active_rank(p_score integer, p_activity_at timestamp with time zone, p_at timestamp with time zone) RETURNS double precision
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
  SELECT CASE
    WHEN p_activity_at < p_at - INTERVAL '7 days' THEN 0::double precision
    ELSE log(greatest(2::numeric, p_score::numeric + 2)::double precision)
      / power(greatest(0::double precision, extract(epoch FROM (p_at - p_activity_at)) / 3600.0) + 2.0, 1.8)
  END
$$;


--
-- Name: bump_reaction_liked_version(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.bump_reaction_liked_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  old_liked boolean := false;
  new_liked boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_liked := OLD.target_kind = 'subject' AND OLD.kind IN ('like', 'love');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_liked := NEW.target_kind = 'subject' AND NEW.kind IN ('like', 'love');
  END IF;
  IF TG_OP = 'UPDATE' AND
    ROW(OLD.route, OLD.actor_account_id, OLD.target_kind, OLD.target_route, OLD.target_id, OLD.kind)
      IS NOT DISTINCT FROM
    ROW(NEW.route, NEW.actor_account_id, NEW.target_kind, NEW.target_route, NEW.target_id, NEW.kind) THEN
    RETURN NULL;
  END IF;
  IF old_liked THEN
    INSERT INTO content.reaction_liked_version AS stored (route, actor_account_id, version)
    VALUES (OLD.route, OLD.actor_account_id, 1)
    ON CONFLICT (route, actor_account_id) DO UPDATE SET version = stored.version + 1;
  END IF;
  IF new_liked AND (NOT old_liked OR
    ROW(NEW.route, NEW.actor_account_id) IS DISTINCT FROM ROW(OLD.route, OLD.actor_account_id)) THEN
    INSERT INTO content.reaction_liked_version AS stored (route, actor_account_id, version)
    VALUES (NEW.route, NEW.actor_account_id, 1)
    ON CONFLICT (route, actor_account_id) DO UPDATE SET version = stored.version + 1;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: guard_author_item(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_author_item() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.author_account_id, NEW.item_kind, NEW.item_id, NEW.thread_id, NEW.thread_kind, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.route, OLD.author_account_id, OLD.item_kind, OLD.item_id, OLD.thread_id, OLD.thread_kind, OLD.created_at)
     OR ROW(NEW.source_epoch, NEW.source_position) <= ROW(OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Author item identity, creation time and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_authored_field(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_authored_field() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Authored document identity must survive erasure' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.id, NEW.subject, NEW.anchor, NEW.candidate, NEW.revision, NEW.author_account_id, NEW.body_sha256,
         NEW.licence, NEW.language, NEW.recorded_xid, NEW.recorded_at)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.id, OLD.subject, OLD.anchor, OLD.candidate, OLD.revision, OLD.author_account_id, OLD.body_sha256,
         OLD.licence, OLD.language, OLD.recorded_xid, OLD.recorded_at)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased' OR NEW.body IS NOT NULL THEN
    RAISE EXCEPTION 'Authored documents are immutable except explicit erasure' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_authored_field_purge(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_authored_field_purge() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Authored field purge source binding is immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_board_thread(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_board_thread() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.board_id, NEW.thread_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.route, OLD.board_id, OLD.thread_id, OLD.created_at)
     OR ROW(NEW.source_epoch, NEW.source_position) < ROW(OLD.source_epoch, OLD.source_position)
     OR (ROW(NEW.source_epoch, NEW.source_position) = ROW(OLD.source_epoch, OLD.source_position)
         AND NEW.source_revision_id IS DISTINCT FROM OLD.source_revision_id)
     OR NEW.last_activity_at < OLD.last_activity_at THEN
    RAISE EXCEPTION 'Board candidate identity, activity and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_edition(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_edition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Edition identity must survive unpublication' USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.route, NEW.edition_id, NEW.creator_account_id, NEW.thread_id, NEW.post_id, NEW.revision_id,
         NEW.body_sha256, NEW.licence, NEW.target_subject_id, NEW.recorded_transaction_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.edition_id, OLD.creator_account_id, OLD.thread_id, OLD.post_id, OLD.revision_id,
         OLD.body_sha256, OLD.licence, OLD.target_subject_id, OLD.recorded_transaction_id, OLD.created_at)
     OR NOT ((OLD.state = 'draft' AND NEW.state = 'published')
          OR (OLD.state = 'published' AND NEW.state = 'unpublished'))
     OR NEW.security_revision <> OLD.security_revision + 1 THEN
    RAISE EXCEPTION 'Edition binding is immutable and unpublication is terminal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_edition_publication(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_edition_publication() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Edition publication provenance is immutable' USING ERRCODE = '23514';
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
  ELSE
    IF (to_jsonb(NEW) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index'])
        IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index']) THEN
      IF (to_jsonb(NEW) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index',
          'initiator_account_id','author_account_id','actor_account_id','original_operator_account_id','actor_client_id','actor_requested_by'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['native_workflow_id','source_epoch','source_partition','source_position','source_event_index',
          'initiator_account_id','author_account_id','actor_account_id','original_operator_account_id','actor_client_id','actor_requested_by'])
        OR (NEW.initiator_account_id IS NOT NULL AND NEW.initiator_account_id IS DISTINCT FROM OLD.initiator_account_id)
        OR (NEW.author_account_id IS NOT NULL AND NEW.author_account_id IS DISTINCT FROM OLD.author_account_id)
        OR (NEW.actor_account_id IS NOT NULL AND NEW.actor_account_id IS DISTINCT FROM OLD.actor_account_id)
        OR (NEW.original_operator_account_id IS NOT NULL AND NEW.original_operator_account_id IS DISTINCT FROM OLD.original_operator_account_id)
        OR (NEW.actor_client_id IS NOT NULL AND NEW.actor_client_id IS DISTINCT FROM OLD.actor_client_id)
        OR (NEW.actor_requested_by IS NOT NULL AND NEW.actor_requested_by IS DISTINCT FROM OLD.actor_requested_by)
        OR OLD.native_workflow_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=OLD.native_workflow_id
          AND status IN ('SUCCESS','ERROR','CANCELLED','MAX_RECOVERY_ATTEMPTS_EXCEEDED')) THEN
        RAISE EXCEPTION 'Operation identity and source binding are immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF OLD.native_workflow_id IS NOT NULL AND ROW(NEW.native_workflow_id, NEW.source_epoch,
        NEW.source_partition, NEW.source_position, NEW.source_event_index) IS DISTINCT FROM
        ROW(OLD.native_workflow_id, OLD.source_epoch, OLD.source_partition, OLD.source_position, OLD.source_event_index) THEN
      RAISE EXCEPTION 'Operation identity and source binding are immutable' USING ERRCODE = '23514';
    END IF;
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
  IF TG_OP = 'UPDATE' AND OLD.author_erased AND NOT NEW.author_erased THEN
    RAISE EXCEPTION 'Author erasure is irreversible' USING ERRCODE = '23514';
  END IF;
  IF OLD.availability = 'erased' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Erased post identity must survive cleanup' USING ERRCODE = '23514';
    END IF;
    IF NEW.head_revision_id IS DISTINCT FROM OLD.head_revision_id
       OR (NEW.availability = 'erased' AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
       OR (NEW.availability <> 'erased' AND
           (OLD.deleted_at IS NULL OR OLD.purge_started_at IS NOT NULL OR OLD.purge_completed)) THEN
      RAISE EXCEPTION 'Purged post erasure is irreversible' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF OLD.purge_started_at IS NOT NULL AND NEW.purge_started_at IS DISTINCT FROM OLD.purge_started_at
     OR OLD.purge_completed AND NOT NEW.purge_completed THEN
    RAISE EXCEPTION 'Post purge is irreversible' USING ERRCODE = '23514';
  END IF;
  IF NEW.availability IS DISTINCT FROM OLD.availability
     AND NEW.security_revision <= OLD.security_revision THEN
    RAISE EXCEPTION 'Post availability requires an increasing security revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_reaction_count(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_reaction_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.target_id, NEW.source_partition, NEW.kind)
       IS DISTINCT FROM ROW(OLD.route, OLD.target_id, OLD.source_partition, OLD.kind)
     OR ROW(NEW.source_epoch, NEW.source_position) < ROW(OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Reaction count identity and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_reaction_total(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_reaction_total() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.target_id, NEW.kind)
       IS DISTINCT FROM ROW(OLD.route, OLD.target_id, OLD.kind)
     OR ROW(NEW.source_epoch, NEW.source_position) < ROW(OLD.source_epoch, OLD.source_position) THEN
    RAISE EXCEPTION 'Reaction total identity and source watermark cannot regress' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_realm_media_claim(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_realm_media_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.claimed_realm_id IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Realm media claims are permanent' USING ERRCODE = '23514';
    END IF;
    IF ROW(NEW.route, NEW.media_id, NEW.container_id, NEW.uploader_id, NEW.purpose, NEW.claimed_at, NEW.claimed_realm_id)
      IS DISTINCT FROM
      ROW(OLD.route, OLD.media_id, OLD.container_id, OLD.uploader_id, OLD.purpose, OLD.claimed_at, OLD.claimed_realm_id) THEN
      RAISE EXCEPTION 'Realm media claims are permanent' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_report(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_report() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.outcome IS NULL AND NEW.outcome IS NOT NULL
     AND (to_jsonb(NEW) - ARRAY['outcome', 'resolved_at', 'resolved_by', 'decision_id'])
       = (to_jsonb(OLD) - ARRAY['outcome', 'resolved_at', 'resolved_by', 'decision_id']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT OLD.reporter_erased AND OLD.reporter_account_id IS NOT NULL
     AND NEW.reporter_erased AND NEW.reporter_account_id IS NULL AND NEW.evidence IS NULL
     AND (to_jsonb(NEW) - ARRAY['evidence', 'reporter_account_id', 'reporter_erased'])
       = (to_jsonb(OLD) - ARRAY['evidence', 'reporter_account_id', 'reporter_erased']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Report records and their resolved outcomes are immutable' USING ERRCODE = '23514';
END;
$$;


--
-- Name: guard_review_revision(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_review_revision() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  thread_kind text;
  first_post_id uuid;
  review_subject_id uuid;
BEGIN
  SELECT t.kind, t.first_post_id, t.review_subject_id
    INTO thread_kind, first_post_id, review_subject_id
  FROM content.thread t
  WHERE t.route = NEW.route AND t.thread_id = NEW.thread_id;

  IF thread_kind IS NULL THEN
    RAISE EXCEPTION 'Revision thread is missing' USING ERRCODE = '23503';
  END IF;
  IF thread_kind = 'review' THEN
    IF NEW.post_id = first_post_id AND NEW.subject_ids IS DISTINCT FROM ARRAY[review_subject_id]::uuid[] THEN
      RAISE EXCEPTION 'A review revision must retain exactly its target subject' USING ERRCODE = '23514';
    END IF;
    IF NEW.post_id <> first_post_id AND NEW.vote_citation IS NOT NULL THEN
      RAISE EXCEPTION 'Only a review first post may cite a vote' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.vote_citation IS NOT NULL THEN
    RAISE EXCEPTION 'Only a review may cite a vote' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_review_thread(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_review_thread() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT OLD.review_live AND NEW.review_live AND NOT EXISTS (
    SELECT 1 FROM content.post p WHERE p.route = NEW.route AND p.post_id = NEW.first_post_id
      AND p.availability = 'available' AND p.purge_started_at IS NULL
      AND p.visibility <> 'taken_down' AND NEW.availability = 'available' AND NEW.visibility <> 'taken_down'
  ) THEN
    RAISE EXCEPTION 'A removed review cannot become live again' USING ERRCODE = '23514';
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
  IF ROW(NEW.route, NEW.thread_id, NEW.post_id, NEW.revision_id,
         NEW.licence, NEW.subject_ids, NEW.board_id, NEW.recorded_transaction_id, NEW.recorded_at,
         NEW.media_ids, NEW.vote_citation)
     IS DISTINCT FROM
     ROW(OLD.route, OLD.thread_id, OLD.post_id, OLD.revision_id,
         OLD.licence, OLD.subject_ids, OLD.board_id, OLD.recorded_transaction_id, OLD.recorded_at,
         OLD.media_ids, OLD.vote_citation)
     OR OLD.availability <> 'available' OR NEW.availability <> 'erased'
     OR OLD.body IS NULL OR OLD.body_sha256 IS NULL
     OR NEW.body IS NOT NULL OR NEW.body_sha256 IS NOT NULL OR NEW.search_text IS NOT NULL
     OR NOT EXISTS (
       SELECT 1 FROM content.post p
       WHERE p.route = OLD.route AND p.thread_id = OLD.thread_id AND p.post_id = OLD.post_id
         AND (p.availability = 'erased' OR
           (p.author_erased AND p.availability = 'available' AND p.visibility = 'published'
            AND p.head_revision_id <> OLD.revision_id))
     ) THEN
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
  IF (NEW.taken_down_at IS NULL) <> (NEW.takedown_id IS NULL)
    OR (NOT NEW.taken_down AND NEW.taken_down_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Source fence takedown time and id must be set together on takedown'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.route, NEW.source, NEW.external_id, NEW.field_group)
        IS DISTINCT FROM ROW(OLD.route, OLD.source, OLD.external_id, OLD.field_group)
      OR NEW.security_revision < OLD.security_revision
      OR (NEW.taken_down IS DISTINCT FROM OLD.taken_down AND NEW.security_revision <= OLD.security_revision) THEN
      RAISE EXCEPTION 'Source fence identity is immutable and takedown requires an increasing security revision'
        USING ERRCODE = '23514';
    END IF;
    IF (OLD.taken_down AND NEW.taken_down)
        AND ROW(NEW.taken_down_at, NEW.takedown_id)
          IS DISTINCT FROM ROW(OLD.taken_down_at, OLD.takedown_id)
      OR (NOT OLD.taken_down AND NEW.taken_down AND NEW.taken_down_at IS NULL) THEN
      RAISE EXCEPTION 'Source fence takedown provenance is immutable and required on transition'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: guard_subject_thread(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.guard_subject_thread() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF ROW(NEW.route, NEW.subject_id, NEW.thread_route, NEW.thread_id)
       IS DISTINCT FROM ROW(OLD.route, OLD.subject_id, OLD.thread_route, OLD.thread_id)
     OR ROW(NEW.source_epoch, NEW.source_position) <= ROW(OLD.source_epoch, OLD.source_position)
     OR NEW.last_activity_at < OLD.last_activity_at THEN
    RAISE EXCEPTION 'Subject thread identity, activity and source watermark cannot regress' USING ERRCODE = '23514';
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
-- Name: operation_routable_uuid(uuid); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.operation_routable_uuid(id uuid) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
  SELECT id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
$_$;


--
-- Name: operation_scopes_valid(text[]); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.operation_scopes_valid(scopes text[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$
  SELECT (cardinality(scopes) = 0 OR array_ndims(scopes) = 1)
    AND cardinality(scopes) <= 512
    AND octet_length(array_to_string(scopes, ' ')) <= 66047
    AND COALESCE(bool_and(scope IS NOT NULL AND scope ~ '^[!-~]{1,128}$'
      AND position('"' in scope) = 0 AND position(chr(92) in scope) = 0), true)
  FROM unnest(scopes) AS scope
$_$;


--
-- Name: record_review_discovery_dependencies(); Type: FUNCTION; Schema: content; Owner: -
--

CREATE FUNCTION content.record_review_discovery_dependencies() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.kind = 'review' THEN
    INSERT INTO content.review_discovery_dependency(route,thread_id,gate_kind,gate_key)
    SELECT NEW.route, NEW.thread_id, keys.kind, keys.id
    FROM content.board b
    LEFT JOIN community.realm r ON r.route = get_byte(uuid_send(b.realm_id),10)*256 + get_byte(uuid_send(b.realm_id),11)
      AND r.realm_id=b.realm_id
    CROSS JOIN LATERAL (VALUES ('thread',NEW.thread_id),('post',NEW.first_post_id),
      ('board',NEW.board_id),('subject',NEW.review_subject_id),('account',NEW.author_account_id),
      ('realm',b.realm_id),('space',r.space_id),('context',r.context_id),
      ('context','00000000-0000-8000-8000-000000000000'::uuid)) AS keys(kind,id)
    WHERE b.route = get_byte(uuid_send(NEW.board_id),10)*256 + get_byte(uuid_send(NEW.board_id),11)
      AND b.board_id=NEW.board_id AND keys.id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account_erasure_progress; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.account_erasure_progress (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    step bigint DEFAULT 0 NOT NULL,
    phase text NOT NULL,
    cursor jsonb,
    erased_at timestamp with time zone NOT NULL,
    content_found boolean DEFAULT false NOT NULL,
    delivery_found boolean DEFAULT false NOT NULL,
    phase_pending boolean DEFAULT false NOT NULL,
    statements_kept_until timestamp with time zone,
    CONSTRAINT account_erasure_progress_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_erasure_progress_erased_at_check CHECK (isfinite(erased_at)),
    CONSTRAINT account_erasure_progress_phase_check CHECK ((phase = ANY (ARRAY['authored'::text, 'uploads'::text, 'reactions'::text, 'moderation'::text, 'notices'::text, 'proof'::text, 'complete'::text]))),
    CONSTRAINT account_erasure_progress_statements_kept_until_check CHECK (((statements_kept_until IS NULL) OR isfinite(statements_kept_until))),
    CONSTRAINT account_erasure_progress_step_check CHECK ((step >= 0))
);


--
-- Name: account_erasure_statement; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.account_erasure_statement (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    due_at timestamp with time zone NOT NULL,
    owner_route integer NOT NULL,
    decision_id uuid NOT NULL,
    CONSTRAINT account_erasure_statement_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_erasure_statement_check1 CHECK ((owner_route = ((get_byte(uuid_send(decision_id), 10) * 256) + get_byte(uuid_send(decision_id), 11)))),
    CONSTRAINT account_erasure_statement_due_at_check CHECK (isfinite(due_at)),
    CONSTRAINT account_erasure_statement_owner_route_check CHECK (((owner_route >= 0) AND (owner_route <= 65535))),
    CONSTRAINT account_erasure_statement_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: account_upload; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.account_upload (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    phase text NOT NULL,
    id uuid NOT NULL,
    CONSTRAINT account_upload_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT account_upload_phase_check CHECK ((phase = ANY (ARRAY['media'::text, 'fields'::text])))
);


--
-- Name: author_item; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.author_item (
    route integer NOT NULL,
    author_account_id uuid NOT NULL,
    item_kind text NOT NULL,
    item_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    thread_kind text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    CONSTRAINT author_item_check CHECK ((route = ((get_byte(uuid_send(author_account_id), 10) * 256) + get_byte(uuid_send(author_account_id), 11)))),
    CONSTRAINT author_item_check1 CHECK ((((item_kind = 'thread'::text) AND (item_id = thread_id)) OR ((item_kind = 'post'::text) AND (item_id <> thread_id)))),
    CONSTRAINT author_item_check2 CHECK (((get_byte(uuid_send(item_id), 10) = get_byte(uuid_send(thread_id), 10)) AND (get_byte(uuid_send(item_id), 11) = get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT author_item_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT author_item_item_kind_check CHECK ((item_kind = ANY (ARRAY['thread'::text, 'post'::text]))),
    CONSTRAINT author_item_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT author_item_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT author_item_source_position_check CHECK ((source_position > 0)),
    CONSTRAINT author_item_thread_kind_check CHECK ((thread_kind = ANY (ARRAY['discussion'::text, 'review'::text])))
);


--
-- Name: authored_field; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.authored_field (
    route integer NOT NULL,
    id uuid NOT NULL,
    subject uuid NOT NULL,
    candidate uuid NOT NULL,
    revision bigint NOT NULL,
    author_account_id uuid NOT NULL,
    body bytea,
    body_sha256 bytea NOT NULL,
    licence text NOT NULL,
    language text NOT NULL,
    availability text NOT NULL,
    recorded_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    recorded_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    anchor uuid,
    CONSTRAINT authored_field_anchor_route_check CHECK (((anchor IS NULL) OR (route = ((get_byte(uuid_send(anchor), 10) * 256) + get_byte(uuid_send(anchor), 11))))),
    CONSTRAINT authored_field_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'erased'::text]))),
    CONSTRAINT authored_field_body_digest CHECK ((body_sha256 = sha256(body))),
    CONSTRAINT authored_field_body_sha256_check CHECK ((octet_length(body_sha256) = 32)),
    CONSTRAINT authored_field_body_size CHECK ((octet_length(body) <= 2097152)),
    CONSTRAINT authored_field_check CHECK ((route = ((get_byte(uuid_send(id), 10) * 256) + get_byte(uuid_send(id), 11)))),
    CONSTRAINT authored_field_check1 CHECK ((route = ((get_byte(uuid_send(subject), 10) * 256) + get_byte(uuid_send(subject), 11)))),
    CONSTRAINT authored_field_check2 CHECK ((route = ((get_byte(uuid_send(candidate), 10) * 256) + get_byte(uuid_send(candidate), 11)))),
    CONSTRAINT authored_field_check3 CHECK ((((availability = 'available'::text) AND (body IS NOT NULL)) OR ((availability = 'erased'::text) AND (body IS NULL)))),
    CONSTRAINT authored_field_language_check CHECK (((length(language) >= 1) AND (length(language) <= 128))),
    CONSTRAINT authored_field_licence_check CHECK (((length(licence) >= 1) AND (length(licence) <= 128))),
    CONSTRAINT authored_field_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT authored_field_route_check CHECK (((route >= 0) AND (route <= 65535)))
);
ALTER TABLE ONLY content.authored_field ALTER COLUMN body SET COMPRESSION lz4;


--
-- Name: authored_field_purge; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.authored_field_purge (
    route integer NOT NULL,
    document_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    candidate_id uuid NOT NULL,
    revision bigint NOT NULL,
    deletion_generation text NOT NULL,
    source_version text NOT NULL,
    deletion_transaction_id text NOT NULL,
    deletion_committed_at timestamp with time zone NOT NULL,
    purge_after timestamp with time zone NOT NULL,
    CONSTRAINT authored_field_purge_check CHECK ((purge_after = (deletion_committed_at + '720:00:00'::interval))),
    CONSTRAINT authored_field_purge_check1 CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT authored_field_purge_check2 CHECK ((route = ((get_byte(uuid_send(candidate_id), 10) * 256) + get_byte(uuid_send(candidate_id), 11)))),
    CONSTRAINT authored_field_purge_deletion_committed_at_check CHECK (isfinite(deletion_committed_at)),
    CONSTRAINT authored_field_purge_deletion_generation_check CHECK ((length(deletion_generation) > 0)),
    CONSTRAINT authored_field_purge_deletion_transaction_id_check CHECK ((length(deletion_transaction_id) > 0)),
    CONSTRAINT authored_field_purge_purge_after_check CHECK (isfinite(purge_after)),
    CONSTRAINT authored_field_purge_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint))),
    CONSTRAINT authored_field_purge_source_version_check CHECK ((length(source_version) > 0))
);


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
    realm_id uuid,
    purpose text DEFAULT 'discussion'::text NOT NULL,
    CONSTRAINT board_check CHECK ((route = ((get_byte(uuid_send(board_id), 10) * 256) + get_byte(uuid_send(board_id), 11)))),
    CONSTRAINT board_purpose_check CHECK ((purpose = ANY (ARRAY['discussion'::text, 'reviews'::text]))),
    CONSTRAINT board_realm_id_routed_check CHECK (((realm_id IS NULL) OR (((realm_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND (route = ((get_byte(uuid_send(realm_id), 10) * 256) + get_byte(uuid_send(realm_id), 11)))))),
    CONSTRAINT board_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT board_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT board_title_size CHECK (((char_length(title) >= 1) AND (char_length(title) <= 1024))),
    CONSTRAINT board_visibility_check CHECK ((visibility = ANY (ARRAY['published'::text, 'draft'::text, 'protected'::text, 'taken_down'::text])))
);


--
-- Name: board_report_candidate; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.board_report_candidate (
    route integer NOT NULL,
    board_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    report_route integer NOT NULL,
    report_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT board_report_candidate_check CHECK ((route = ((get_byte(uuid_send(board_id), 10) * 256) + get_byte(uuid_send(board_id), 11)))),
    CONSTRAINT board_report_candidate_check1 CHECK ((report_route = ((get_byte(uuid_send(report_id), 10) * 256) + get_byte(uuid_send(report_id), 11)))),
    CONSTRAINT board_report_candidate_report_route_check CHECK (((report_route >= 0) AND (report_route <= 65535))),
    CONSTRAINT board_report_candidate_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT board_report_candidate_target_kind_check CHECK ((target_kind = ANY (ARRAY['board'::text, 'thread'::text, 'post'::text])))
);


--
-- Name: board_slow_actor; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.board_slow_actor (
    route integer NOT NULL,
    board_id uuid NOT NULL,
    actor_key bytea NOT NULL,
    posted_at timestamp with time zone NOT NULL,
    CONSTRAINT board_slow_actor_actor_key_check CHECK ((octet_length(actor_key) = 32))
);


--
-- Name: board_slow_mode; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.board_slow_mode (
    route integer NOT NULL,
    board_id uuid NOT NULL,
    interval_seconds integer NOT NULL,
    CONSTRAINT board_slow_mode_interval_seconds_check CHECK (((interval_seconds >= 0) AND (interval_seconds <= 86400)))
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
    last_activity_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    score integer DEFAULT 0 NOT NULL,
    active_rank double precision DEFAULT 0 NOT NULL,
    rank_refreshed_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    hot_rank double precision DEFAULT 0 NOT NULL,
    pin_slot smallint,
    CONSTRAINT board_thread_active_rank_finite CHECK (((active_rank >= (0)::double precision) AND (active_rank < 'Infinity'::double precision))),
    CONSTRAINT board_thread_check CHECK ((route = ((get_byte(uuid_send(board_id), 10) * 256) + get_byte(uuid_send(board_id), 11)))),
    CONSTRAINT board_thread_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT board_thread_hot_rank_finite CHECK (((hot_rank >= (0)::double precision) AND (hot_rank < 'Infinity'::double precision))),
    CONSTRAINT board_thread_last_activity_finite CHECK (isfinite(last_activity_at)),
    CONSTRAINT board_thread_pin_slot_check CHECK (((pin_slot IS NULL) OR ((pin_slot >= 1) AND (pin_slot <= 3)))),
    CONSTRAINT board_thread_rank_refreshed_finite CHECK (isfinite(rank_refreshed_at)),
    CONSTRAINT board_thread_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT board_thread_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT board_thread_source_position_check CHECK ((source_position > 0))
);


--
-- Name: board_watch; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.board_watch (
    route integer NOT NULL,
    watcher_account_id uuid NOT NULL,
    board_id uuid NOT NULL,
    watch_id uuid NOT NULL,
    watching boolean NOT NULL,
    revision integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT board_watch_check CHECK ((route = ((get_byte(uuid_send(watcher_account_id), 10) * 256) + get_byte(uuid_send(watcher_account_id), 11)))),
    CONSTRAINT board_watch_check1 CHECK ((route = ((get_byte(uuid_send(watch_id), 10) * 256) + get_byte(uuid_send(watch_id), 11)))),
    CONSTRAINT board_watch_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT board_watch_revision_check CHECK ((revision > 0)),
    CONSTRAINT board_watch_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: board_watch_notice_work; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.board_watch_notice_work (
    route integer NOT NULL,
    post_id uuid NOT NULL,
    board_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    source_id uuid NOT NULL,
    published_at timestamp with time zone NOT NULL,
    cursor_created_at timestamp with time zone,
    cursor_watch_id uuid,
    done boolean DEFAULT false NOT NULL,
    CONSTRAINT board_watch_notice_work_check CHECK (((cursor_created_at IS NULL) = (cursor_watch_id IS NULL))),
    CONSTRAINT board_watch_notice_work_check1 CHECK ((route = ((get_byte(uuid_send(post_id), 10) * 256) + get_byte(uuid_send(post_id), 11)))),
    CONSTRAINT board_watch_notice_work_check2 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT board_watch_notice_work_published_at_check CHECK (isfinite(published_at)),
    CONSTRAINT board_watch_notice_work_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT board_watch_notice_work_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT board_watch_notice_work_source_position_check CHECK ((source_position > 0))
);


--
-- Name: catalogue_report_candidate; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.catalogue_report_candidate (
    route integer NOT NULL,
    report_route integer NOT NULL,
    report_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT catalogue_report_candidate_check CHECK ((report_route = ((get_byte(uuid_send(report_id), 10) * 256) + get_byte(uuid_send(report_id), 11)))),
    CONSTRAINT catalogue_report_candidate_report_route_check CHECK (((report_route >= 0) AND (report_route <= 65535))),
    CONSTRAINT catalogue_report_candidate_route_check CHECK ((route = 0))
);


--
-- Name: creator_edition; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.creator_edition (
    route integer NOT NULL,
    creator_account_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    CONSTRAINT creator_edition_check CHECK ((route = ((get_byte(uuid_send(creator_account_id), 10) * 256) + get_byte(uuid_send(creator_account_id), 11)))),
    CONSTRAINT creator_edition_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: edition; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.edition (
    route integer NOT NULL,
    edition_id uuid NOT NULL,
    creator_account_id uuid NOT NULL,
    target_subject_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    post_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    body_sha256 bytea NOT NULL,
    licence text NOT NULL,
    state text NOT NULL,
    security_revision bigint NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT edition_body_sha256_check CHECK ((octet_length(body_sha256) = 32)),
    CONSTRAINT edition_check CHECK ((route = ((get_byte(uuid_send(edition_id), 10) * 256) + get_byte(uuid_send(edition_id), 11)))),
    CONSTRAINT edition_check1 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT edition_check2 CHECK ((route = ((get_byte(uuid_send(post_id), 10) * 256) + get_byte(uuid_send(post_id), 11)))),
    CONSTRAINT edition_check3 CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT edition_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT edition_licence_check CHECK (((char_length(licence) >= 1) AND (char_length(licence) <= 128))),
    CONSTRAINT edition_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT edition_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT edition_state_check CHECK ((state = ANY (ARRAY['draft'::text, 'published'::text, 'unpublished'::text])))
);


--
-- Name: edition_publication; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.edition_publication (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    edition_id uuid NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    initiator_account_id uuid NOT NULL,
    actor_client_id text NOT NULL,
    actor_scopes text[] NOT NULL,
    actor_requested_by text,
    actor_authn_epoch bigint NOT NULL,
    original_minimum_authn_epoch text NOT NULL,
    original_operator_account_id uuid,
    original_delegation_transaction_id uuid,
    original_delegation_issued_valid text,
    source_digest text NOT NULL,
    creation_idempotency_key text NOT NULL,
    creation_request_digest text NOT NULL,
    CONSTRAINT edition_publication_actor_authn_epoch_check CHECK ((actor_authn_epoch > 0)),
    CONSTRAINT edition_publication_actor_scopes_check CHECK ((cardinality(actor_scopes) <= 512)),
    CONSTRAINT edition_publication_check CHECK ((route = ((get_byte(uuid_send(operation_id), 10) * 256) + get_byte(uuid_send(operation_id), 11)))),
    CONSTRAINT edition_publication_check1 CHECK ((((actor_requested_by IS NULL) AND (original_delegation_transaction_id IS NULL) AND (original_delegation_issued_valid IS NULL)) OR ((actor_requested_by IS NOT NULL) AND (original_delegation_transaction_id IS NOT NULL) AND (original_delegation_issued_valid IS NOT NULL)))),
    CONSTRAINT edition_publication_creation_request_digest_check CHECK ((creation_request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT edition_publication_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: erasure_fence; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.erasure_fence (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    closed_at timestamp with time zone,
    CONSTRAINT erasure_fence_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT erasure_fence_closed_at_check CHECK (((closed_at IS NULL) OR isfinite(closed_at)))
);


--
-- Name: feed_activity; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.feed_activity (
    route integer NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    activity_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    activity jsonb NOT NULL,
    CONSTRAINT feed_activity_activity_id_check CHECK ((octet_length(activity_id) <= 512)),
    CONSTRAINT feed_activity_check CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT feed_activity_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT feed_activity_target_type_check CHECK ((target_type = ANY (ARRAY['subject'::text, 'collection'::text, 'space'::text])))
);


--
-- Name: TABLE feed_activity; Type: COMMENT; Schema: content; Owner: -
--

COMMENT ON TABLE content.feed_activity IS 'Body-free retained candidate references. The original owner and current follow authorize every read.';


--
-- Name: feed_inbox; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.feed_inbox (
    route integer NOT NULL,
    partition_no integer GENERATED ALWAYS AS ((route >> 4)) STORED,
    account_id uuid NOT NULL,
    activity_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    activity jsonb NOT NULL,
    CONSTRAINT feed_inbox_activity_id_check CHECK ((octet_length(activity_id) <= 512)),
    CONSTRAINT feed_inbox_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT feed_inbox_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: TABLE feed_inbox; Type: COMMENT; Schema: content; Owner: -
--

COMMENT ON TABLE content.feed_inbox IS 'Private recent candidate inbox, capped at 2000 references and read only within 30 days. No discovery authority.';


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
    width integer,
    height integer,
    thumbhash bytea,
    average_color text,
    crop integer[],
    focal_x real,
    focal_y real,
    claimed_item_id uuid,
    claimed_realm_id uuid,
    CONSTRAINT media_actual_byte_count_check CHECK (((actual_byte_count IS NULL) OR (actual_byte_count > 0))),
    CONSTRAINT media_avatar_owner_check CHECK (((purpose <> 'avatar'::text) OR ((container_id = uploader_id) AND (source_url IS NULL) AND (credit IS NULL) AND (provenance IS NULL)))),
    CONSTRAINT media_byte_count_check CHECK (((byte_count >= 1) AND (byte_count <= 20971520))),
    CONSTRAINT media_check CHECK ((route = ((get_byte(uuid_send(media_id), 10) * 256) + get_byte(uuid_send(media_id), 11)))),
    CONSTRAINT media_check1 CHECK ((route = ((get_byte(uuid_send(container_id), 10) * 256) + get_byte(uuid_send(container_id), 11)))),
    CONSTRAINT media_check2 CHECK ((key = (('m/'::text || (media_id)::text) || '/original'::text))),
    CONSTRAINT media_check3 CHECK (((sha256 IS NULL) OR (declared_sha256 IS NULL) OR (sha256 = declared_sha256))),
    CONSTRAINT media_check5 CHECK (((claimed_at IS NULL) OR (state = 'available'::text))),
    CONSTRAINT media_check6 CHECK (((NOT collection_pending) OR (claimed_at IS NULL))),
    CONSTRAINT media_check7 CHECK ((NOT (collection_pending AND erased))),
    CONSTRAINT media_claimed_item_check CHECK (((claimed_item_id IS NULL) OR ((purpose = 'post-image'::text) AND (claimed_at IS NOT NULL)))),
    CONSTRAINT media_claimed_item_route_check CHECK ((route = ((get_byte(uuid_send(claimed_item_id), 10) * 256) + get_byte(uuid_send(claimed_item_id), 11)))),
    CONSTRAINT media_cover_metadata_size CHECK (((purpose <> 'cover'::text) OR (((char_length(source_url) >= 1) AND (char_length(source_url) <= 2048)) AND (octet_length(convert_to((credit)::text, 'UTF8'::name)) <= 8192) AND ((char_length((credit ->> 'rightsHolder'::text)) >= 1) AND (char_length((credit ->> 'rightsHolder'::text)) <= 1024)) AND ((char_length(((credit -> 'via'::text) ->> 'name'::text)) >= 1) AND (char_length(((credit -> 'via'::text) ->> 'name'::text)) <= 1024)) AND ((char_length(((credit -> 'via'::text) ->> 'url'::text)) >= 1) AND (char_length(((credit -> 'via'::text) ->> 'url'::text)) <= 1024)) AND ((char_length((credit ->> 'license'::text)) >= 1) AND (char_length((credit ->> 'license'::text)) <= 128)) AND (((credit ->> 'license'::text) ~ '^[A-Za-z0-9.+-]+$'::text) OR ((credit ->> 'license'::text) ~ '^LicenseRef-[A-Za-z0-9.-]+$'::text)) AND (octet_length(convert_to((provenance)::text, 'UTF8'::name)) <= 65536) AND ((jsonb_array_length((provenance -> 'references'::text)) >= 1) AND (jsonb_array_length((provenance -> 'references'::text)) <= 128))))),
    CONSTRAINT media_cover_provenance_check CHECK (((purpose <> 'cover'::text) OR (((source_url IS NOT NULL) AND (source_url ~ '^https://[^[:space:]]+$'::text) AND (char_length(source_url) <= 2048) AND (credit IS NOT NULL) AND (jsonb_typeof(credit) = 'object'::text) AND (jsonb_typeof((credit -> 'rightsHolder'::text)) = 'string'::text) AND ((char_length((credit ->> 'rightsHolder'::text)) >= 1) AND (char_length((credit ->> 'rightsHolder'::text)) <= 1024)) AND (jsonb_typeof((credit -> 'via'::text)) = 'object'::text) AND (jsonb_typeof(((credit -> 'via'::text) -> 'name'::text)) = 'string'::text) AND ((char_length(((credit -> 'via'::text) ->> 'name'::text)) >= 1) AND (char_length(((credit -> 'via'::text) ->> 'name'::text)) <= 1024)) AND (((credit -> 'via'::text) ->> 'url'::text) ~ '^https://[^[:space:]]+$'::text) AND (jsonb_typeof((credit -> 'license'::text)) = 'string'::text) AND (char_length((credit ->> 'license'::text)) > 0) AND (jsonb_typeof((credit -> 'obligations'::text)) = 'array'::text) AND (provenance IS NOT NULL) AND (jsonb_typeof(provenance) = 'object'::text) AND ((provenance ->> 'source'::text) ~ '^[a-z][a-z0-9_-]{0,31}$'::text) AND (char_length((provenance ->> 'external_id'::text)) > 0) AND (char_length((provenance ->> 'record_revision'::text)) > 0) AND ((provenance ->> 'digest'::text) ~ '^[0-9a-f]{64}$'::text) AND (char_length((provenance ->> 'converter_revision'::text)) > 0) AND ((provenance ->> 'field_group'::text) = 'cover'::text) AND (jsonb_typeof((provenance -> 'references'::text)) = 'array'::text) AND ((jsonb_array_length((provenance -> 'references'::text)) >= 1) AND (jsonb_array_length((provenance -> 'references'::text)) <= 128))) IS TRUE))),
    CONSTRAINT media_crop_check CHECK (((crop IS NULL) OR ((array_ndims(crop) = 1) AND (array_lower(crop, 1) = 1) AND (cardinality(crop) = 4) AND (array_position(crop, NULL::integer) IS NULL) AND (crop[1] >= 0) AND (crop[2] >= 0) AND (crop[3] >= 1) AND (crop[4] >= 1)))),
    CONSTRAINT media_decision_check CHECK (((decision IS NULL) OR (char_length(decision) > 0))),
    CONSTRAINT media_declared_measurements_check CHECK (((purpose = 'cover'::text) OR ((byte_count IS NOT NULL) AND (media_type IS NOT NULL)))),
    CONSTRAINT media_declared_sha256_check CHECK ((declared_sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT media_focal_point_check CHECK ((((focal_x IS NULL) AND (focal_y IS NULL)) OR ((focal_x IS NOT NULL) AND (focal_y IS NOT NULL) AND (focal_x >= (0)::double precision) AND (focal_x <= (1)::double precision) AND (focal_y >= (0)::double precision) AND (focal_y <= (1)::double precision)))),
    CONSTRAINT media_measurements_check CHECK (((((state = 'reserved'::text) AND (actual_byte_count IS NULL) AND (sha256 IS NULL) AND (decision IS NULL) AND (claimed_at IS NULL)) OR ((state = ANY (ARRAY['uploaded'::text, 'available'::text, 'rejected'::text])) AND (byte_count IS NOT NULL) AND (media_type IS NOT NULL) AND (actual_byte_count IS NOT NULL) AND (actual_byte_count = byte_count) AND (sha256 IS NOT NULL) AND (((state = 'uploaded'::text) AND (decision IS NULL) AND (claimed_at IS NULL)) OR ((state = 'available'::text) AND (decision IS NULL)) OR ((state = 'rejected'::text) AND (decision IS NOT NULL) AND (claimed_at IS NULL)))) OR ((purpose = 'cover'::text) AND (state = 'rejected'::text) AND (byte_count IS NULL) AND (media_type IS NULL) AND (actual_byte_count IS NULL) AND (sha256 IS NULL) AND (declared_sha256 IS NULL) AND (decision IS NOT NULL) AND (claimed_at IS NULL))) IS TRUE)),
    CONSTRAINT media_media_type_check CHECK ((media_type = ANY (ARRAY['image/avif'::text, 'image/gif'::text, 'image/jpeg'::text, 'image/png'::text, 'image/webp'::text]))),
    CONSTRAINT media_purpose_check CHECK ((purpose = ANY (ARRAY['post-image'::text, 'cover'::text, 'avatar'::text, 'realm-icon'::text, 'realm-banner'::text]))),
    CONSTRAINT media_realm_asset_check CHECK (((purpose <> ALL (ARRAY['realm-icon'::text, 'realm-banner'::text])) OR ((source_url IS NULL) AND (credit IS NULL) AND (provenance IS NULL) AND (claimed_item_id IS NULL)))),
    CONSTRAINT media_realm_claim_check CHECK (((claimed_realm_id IS NULL) OR ((purpose = ANY (ARRAY['realm-icon'::text, 'realm-banner'::text])) AND (claimed_realm_id = container_id) AND (claimed_at IS NOT NULL)))),
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
-- Name: moderation_appeal; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.moderation_appeal (
    route integer NOT NULL,
    appeal_id uuid NOT NULL,
    decision_id uuid NOT NULL,
    appellant_account_id uuid NOT NULL,
    statement text NOT NULL,
    thread_id uuid NOT NULL,
    board_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    outcome text,
    resolver_account_id uuid,
    resolver_statement text,
    resolved_at timestamp with time zone,
    CONSTRAINT moderation_appeal_check CHECK ((route = ((get_byte(uuid_send(appeal_id), 10) * 256) + get_byte(uuid_send(appeal_id), 11)))),
    CONSTRAINT moderation_appeal_check1 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT moderation_appeal_check2 CHECK ((((outcome IS NULL) AND (resolver_account_id IS NULL) AND (resolver_statement IS NULL) AND (resolved_at IS NULL)) OR ((outcome IS NOT NULL) AND (resolver_account_id IS NOT NULL) AND (resolver_statement IS NOT NULL) AND (resolved_at IS NOT NULL)))),
    CONSTRAINT moderation_appeal_outcome_check CHECK ((outcome = ANY (ARRAY['upheld'::text, 'reversed'::text]))),
    CONSTRAINT moderation_appeal_resolver_statement_check CHECK (((char_length(resolver_statement) >= 1) AND (char_length(resolver_statement) <= 2000))),
    CONSTRAINT moderation_appeal_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT moderation_appeal_statement_check CHECK (((char_length(statement) >= 1) AND (char_length(statement) <= 2000)))
);


--
-- Name: moderation_appeal_board; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.moderation_appeal_board (
    route integer NOT NULL,
    board_id uuid NOT NULL,
    appeal_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    pending boolean NOT NULL,
    CONSTRAINT moderation_appeal_board_check CHECK ((route = ((get_byte(uuid_send(board_id), 10) * 256) + get_byte(uuid_send(board_id), 11)))),
    CONSTRAINT moderation_appeal_board_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: moderation_decision; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.moderation_decision (
    route integer NOT NULL,
    decision_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    action text NOT NULL,
    statement text NOT NULL,
    decider_account_id uuid,
    decided_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    security_revision bigint NOT NULL,
    CONSTRAINT moderation_decision_action_check CHECK ((action = 'takedown'::text)),
    CONSTRAINT moderation_decision_check CHECK ((route = ((get_byte(uuid_send(decision_id), 10) * 256) + get_byte(uuid_send(decision_id), 11)))),
    CONSTRAINT moderation_decision_check1 CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT moderation_decision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT moderation_decision_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT moderation_decision_statement_check CHECK (((char_length(statement) >= 0) AND (char_length(statement) <= 1024))),
    CONSTRAINT moderation_decision_target_kind_check CHECK ((target_kind = ANY (ARRAY['board'::text, 'thread'::text, 'post'::text])))
);


--
-- Name: notice; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.notice (
    route integer NOT NULL,
    recipient_id uuid NOT NULL,
    notice_id uuid NOT NULL,
    kind text NOT NULL,
    actor_id uuid,
    thread_id uuid,
    post_id uuid,
    decision_id uuid,
    report_id uuid,
    source_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    CONSTRAINT notice_check CHECK ((route = ((get_byte(uuid_send(recipient_id), 10) * 256) + get_byte(uuid_send(recipient_id), 11)))),
    CONSTRAINT notice_check1 CHECK ((route = ((get_byte(uuid_send(notice_id), 10) * 256) + get_byte(uuid_send(notice_id), 11)))),
    CONSTRAINT notice_kind_check CHECK ((kind = ANY (ARRAY['reply'::text, 'mention'::text, 'thread_watch'::text, 'board_activity'::text, 'moderation_decision'::text]))),
    CONSTRAINT notice_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: notice_finalization; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.notice_finalization (
    route integer NOT NULL,
    recipient_id uuid NOT NULL,
    kind text NOT NULL,
    source_id uuid NOT NULL,
    sent boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT notice_finalization_check CHECK ((route = ((get_byte(uuid_send(recipient_id), 10) * 256) + get_byte(uuid_send(recipient_id), 11)))),
    CONSTRAINT notice_finalization_kind_check CHECK ((kind = ANY (ARRAY['reply'::text, 'mention'::text, 'thread_watch'::text, 'board_activity'::text]))),
    CONSTRAINT notice_finalization_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: notice_seen; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.notice_seen (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    seen_notice_id uuid NOT NULL,
    seen_at timestamp with time zone NOT NULL,
    seen_created_at timestamp with time zone NOT NULL,
    CONSTRAINT notice_seen_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT notice_seen_check1 CHECK ((route = ((get_byte(uuid_send(seen_notice_id), 10) * 256) + get_byte(uuid_send(seen_notice_id), 11)))),
    CONSTRAINT notice_seen_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: operation; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.operation (
    route integer NOT NULL,
    operation_id uuid NOT NULL,
    initiator_account_id uuid,
    author_account_id uuid,
    thread_id uuid NOT NULL,
    actor_kind text NOT NULL,
    actor_account_id uuid,
    actor_client_id text,
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
    source_digest text,
    original_minimum_authn_epoch text,
    original_operator_account_id uuid,
    original_delegation_transaction_id uuid,
    original_delegation_issued_valid text,
    creation_command_kind text,
    creation_idempotency_key text,
    creation_request_digest text,
    creation_target_route integer,
    creation_target_id uuid,
    anchor_post_id uuid NOT NULL,
    CONSTRAINT operation_actor_authn_epoch_check CHECK (((actor_authn_epoch >= 1) AND (actor_authn_epoch <= '9007199254740991'::bigint))),
    CONSTRAINT operation_actor_client_id_check CHECK (((char_length(actor_client_id) >= 1) AND (char_length(actor_client_id) <= 1024))),
    CONSTRAINT operation_actor_kind_check CHECK ((actor_kind = 'account'::text)),
    CONSTRAINT operation_actor_requested_by_check CHECK ((actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)),
    CONSTRAINT operation_actor_scopes_check CHECK (content.operation_scopes_valid(actor_scopes)),
    CONSTRAINT operation_anchor_post_id_check CHECK (content.operation_routable_uuid(anchor_post_id)),
    CONSTRAINT operation_anchor_post_route CHECK ((route = ((get_byte(uuid_send(anchor_post_id), 10) * 256) + get_byte(uuid_send(anchor_post_id), 11)))),
    CONSTRAINT operation_check CHECK ((actor_account_id = initiator_account_id)),
    CONSTRAINT operation_check1 CHECK ((route = ((get_byte(uuid_send(operation_id), 10) * 256) + get_byte(uuid_send(operation_id), 11)))),
    CONSTRAINT operation_check2 CHECK (((route >> 4) = (((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)) >> 4))),
    CONSTRAINT operation_check3 CHECK (((empty_scope AND (upper_created_at IS NULL) AND (upper_post_id IS NULL)) OR ((NOT empty_scope) AND (upper_created_at IS NOT NULL) AND (upper_post_id IS NOT NULL) AND isfinite(upper_created_at) AND (upper_created_at <= requested_at) AND (SUBSTRING(uuid_send(upper_post_id) FROM 11 FOR 2) = SUBSTRING(uuid_send(thread_id) FROM 11 FOR 2))))),
    CONSTRAINT operation_check4 CHECK (((num_nonnulls(native_workflow_id, source_epoch, source_partition, source_position, source_event_index) = 0) OR ((num_nonnulls(native_workflow_id, source_epoch, source_partition, source_position, source_event_index) = 5) AND (source_epoch > 0) AND (source_partition = (route >> 4)) AND (source_position > 0) AND (source_event_index >= 0) AND (native_workflow_id = ((((((((('fx:'::text || source_epoch) || ':'::text) || source_partition) || ':'::text) || source_position) || ':'::text) || source_event_index) || ':content_author_erase_'::text) || operation_id))))),
    CONSTRAINT operation_creation_command_kind_check CHECK ((creation_command_kind = 'content.author-erasure'::text)),
    CONSTRAINT operation_creation_idempotency_key_check CHECK ((creation_idempotency_key ~ '^[!-~]{1,255}$'::text)),
    CONSTRAINT operation_creation_request_digest_check CHECK ((creation_request_digest ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT operation_creation_target_id_check CHECK (content.operation_routable_uuid(creation_target_id)),
    CONSTRAINT operation_creation_target_route CHECK ((creation_target_route = ((get_byte(uuid_send(creation_target_id), 10) * 256) + get_byte(uuid_send(creation_target_id), 11)))),
    CONSTRAINT operation_creation_target_route_check CHECK (((creation_target_route >= 0) AND (creation_target_route <= 65535))),
    CONSTRAINT operation_initiator_wire CHECK (((source_digest IS NULL) OR (content.operation_routable_uuid(operation_id) AND content.operation_routable_uuid(initiator_account_id) AND content.operation_routable_uuid(recorded_transaction_id) AND content.operation_routable_uuid(thread_id) AND content.operation_routable_uuid(author_account_id) AND content.operation_routable_uuid(upper_post_id) AND (actor_client_id ~ '^[!-~]+$'::text) AND (cardinality(actor_scopes) <= 512) AND ((actor_requested_by IS NULL) OR ((char_length(actor_requested_by) <= 128) AND (actor_requested_by ~ '^urn:rezics:request:[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)))))),
    CONSTRAINT operation_original_delegation_issued_valid_check CHECK (((char_length(original_delegation_issued_valid) >= 1) AND (char_length(original_delegation_issued_valid) <= 256))),
    CONSTRAINT operation_original_delegation_transaction_id_check CHECK (content.operation_routable_uuid(original_delegation_transaction_id)),
    CONSTRAINT operation_original_minimum_authn_epoch_check CHECK ((original_minimum_authn_epoch ~ '^[1-9][0-9]{0,18}$'::text)),
    CONSTRAINT operation_original_operator_account_id_check CHECK (content.operation_routable_uuid(original_operator_account_id)),
    CONSTRAINT operation_requested_at_check CHECK (isfinite(requested_at)),
    CONSTRAINT operation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT operation_source_digest_check CHECK ((source_digest ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: party_locator; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.party_locator (
    route integer NOT NULL,
    account_id uuid NOT NULL,
    kind text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    owner_route integer NOT NULL,
    owner_id uuid NOT NULL,
    CONSTRAINT party_locator_check CHECK ((route = ((get_byte(uuid_send(account_id), 10) * 256) + get_byte(uuid_send(account_id), 11)))),
    CONSTRAINT party_locator_check1 CHECK ((owner_route = ((get_byte(uuid_send(owner_id), 10) * 256) + get_byte(uuid_send(owner_id), 11)))),
    CONSTRAINT party_locator_due_at_check CHECK (isfinite(due_at)),
    CONSTRAINT party_locator_kind_check CHECK ((kind = ANY (ARRAY['decision'::text, 'operation'::text]))),
    CONSTRAINT party_locator_owner_route_check CHECK (((owner_route >= 0) AND (owner_route <= 65535))),
    CONSTRAINT party_locator_route_check CHECK (((route >= 0) AND (route <= 65535)))
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
    deleted_at timestamp with time zone,
    purge_started_at timestamp with time zone,
    purge_completed boolean DEFAULT false NOT NULL,
    author_erased boolean DEFAULT false NOT NULL,
    CONSTRAINT post_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'erased'::text]))),
    CONSTRAINT post_check CHECK ((route = ((get_byte(uuid_send(post_id), 10) * 256) + get_byte(uuid_send(post_id), 11)))),
    CONSTRAINT post_check1 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT post_check2 CHECK ((route = ((get_byte(uuid_send(reply_to_post_id), 10) * 256) + get_byte(uuid_send(reply_to_post_id), 11)))),
    CONSTRAINT post_check3 CHECK ((route = ((get_byte(uuid_send(head_revision_id), 10) * 256) + get_byte(uuid_send(head_revision_id), 11)))),
    CONSTRAINT post_check4 CHECK ((reply_to_post_id <> post_id)),
    CONSTRAINT post_deletion_state CHECK (((deleted_at IS NULL) OR (availability = 'erased'::text))),
    CONSTRAINT post_purge_state CHECK ((((purge_started_at IS NULL) OR (availability = 'erased'::text)) AND ((NOT purge_completed) OR (purge_started_at IS NOT NULL)))),
    CONSTRAINT post_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT post_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT post_visibility_check CHECK ((visibility = ANY (ARRAY['published'::text, 'draft'::text, 'protected'::text, 'taken_down'::text])))
);


--
-- Name: reaction; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.reaction (
    route integer NOT NULL,
    actor_account_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_route integer NOT NULL,
    target_id uuid NOT NULL,
    kind text NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT reaction_check CHECK ((route = ((get_byte(uuid_send(actor_account_id), 10) * 256) + get_byte(uuid_send(actor_account_id), 11)))),
    CONSTRAINT reaction_check1 CHECK ((target_route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT reaction_kind_check CHECK ((kind = ANY (ARRAY['upvote'::text, 'downvote'::text, 'like'::text, 'love'::text, 'laugh'::text, 'insightful'::text, 'sad'::text]))),
    CONSTRAINT reaction_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT reaction_subject_kind_check CHECK (((target_kind <> 'subject'::text) OR (kind = ANY (ARRAY['like'::text, 'love'::text, 'laugh'::text, 'insightful'::text, 'sad'::text])))),
    CONSTRAINT reaction_target_kind_check CHECK ((target_kind = ANY (ARRAY['thread'::text, 'post'::text, 'subject'::text]))),
    CONSTRAINT reaction_target_route_check CHECK (((target_route >= 0) AND (target_route <= 65535)))
);


--
-- Name: reaction_contribution; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.reaction_contribution (
    route integer NOT NULL,
    target_id uuid NOT NULL,
    actor_account_id uuid NOT NULL,
    kind text,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    CONSTRAINT reaction_contribution_check CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT reaction_contribution_kind_check CHECK ((kind = ANY (ARRAY['upvote'::text, 'downvote'::text, 'like'::text, 'love'::text, 'laugh'::text, 'insightful'::text, 'sad'::text]))),
    CONSTRAINT reaction_contribution_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT reaction_contribution_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT reaction_contribution_source_position_check CHECK ((source_position > 0))
);


--
-- Name: reaction_count; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.reaction_count (
    route integer NOT NULL,
    target_id uuid NOT NULL,
    source_partition integer NOT NULL,
    kind text NOT NULL,
    count integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    CONSTRAINT reaction_count_check CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT reaction_count_count_check CHECK ((count >= 0)),
    CONSTRAINT reaction_count_kind_check CHECK ((kind = ANY (ARRAY['upvote'::text, 'downvote'::text, 'like'::text, 'love'::text, 'laugh'::text, 'insightful'::text, 'sad'::text]))),
    CONSTRAINT reaction_count_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT reaction_count_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT reaction_count_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095))),
    CONSTRAINT reaction_count_source_position_check CHECK ((source_position > 0))
);


--
-- Name: reaction_liked_version; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.reaction_liked_version (
    route integer NOT NULL,
    actor_account_id uuid NOT NULL,
    version bigint NOT NULL,
    CONSTRAINT reaction_liked_version_check CHECK ((route = ((get_byte(uuid_send(actor_account_id), 10) * 256) + get_byte(uuid_send(actor_account_id), 11)))),
    CONSTRAINT reaction_liked_version_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT reaction_liked_version_version_check CHECK ((version > 0))
);


--
-- Name: reaction_projection_baseline; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.reaction_projection_baseline (
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    CONSTRAINT reaction_projection_baseline_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT reaction_projection_baseline_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095))),
    CONSTRAINT reaction_projection_baseline_source_position_check CHECK ((source_position >= 0))
);


--
-- Name: reaction_total; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.reaction_total (
    route integer NOT NULL,
    target_id uuid NOT NULL,
    kind text NOT NULL,
    count integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    CONSTRAINT reaction_total_check CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT reaction_total_count_check CHECK ((count >= 0)),
    CONSTRAINT reaction_total_kind_check CHECK ((kind = ANY (ARRAY['upvote'::text, 'downvote'::text, 'like'::text, 'love'::text, 'laugh'::text, 'insightful'::text, 'sad'::text]))),
    CONSTRAINT reaction_total_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT reaction_total_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT reaction_total_source_position_check CHECK ((source_position > 0))
);


--
-- Name: realm_discovery_contribution; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_discovery_contribution (
    route integer NOT NULL,
    thread_id uuid NOT NULL,
    board_id uuid NOT NULL,
    realm_id uuid NOT NULL,
    space_id uuid NOT NULL,
    realm_epoch bigint NOT NULL,
    creation_day date NOT NULL,
    created_at timestamp with time zone NOT NULL,
    source_version bigint DEFAULT 1 NOT NULL,
    contributing boolean DEFAULT true NOT NULL,
    CONSTRAINT realm_discovery_contribution_check CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT realm_discovery_contribution_check1 CHECK ((creation_day = ((created_at AT TIME ZONE 'UTC'::text))::date)),
    CONSTRAINT realm_discovery_contribution_realm_epoch_check CHECK ((realm_epoch > 0)),
    CONSTRAINT realm_discovery_contribution_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_discovery_contribution_source_version_check CHECK ((source_version > 0))
);


--
-- Name: realm_discovery_operation; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_discovery_operation (
    route integer NOT NULL,
    intent text NOT NULL,
    generation bigint NOT NULL,
    target_kind text NOT NULL,
    effect text NOT NULL,
    target_id uuid NOT NULL,
    native_version bigint NOT NULL,
    source_version bigint NOT NULL,
    thread_id uuid,
    board_id uuid NOT NULL,
    realm_id uuid NOT NULL,
    space_id uuid NOT NULL,
    realm_epoch bigint NOT NULL,
    phase text DEFAULT 'prepared'::text NOT NULL,
    fence_generation bigint,
    preparation_transaction_id uuid NOT NULL,
    outcome_transaction_id uuid,
    projected boolean DEFAULT false NOT NULL,
    CONSTRAINT realm_discovery_operation_check CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT realm_discovery_operation_check1 CHECK (((phase <> 'ready'::text) OR (fence_generation IS NOT NULL))),
    CONSTRAINT realm_discovery_operation_check2 CHECK (((phase = ANY (ARRAY['applied'::text, 'aborted'::text])) = (outcome_transaction_id IS NOT NULL))),
    CONSTRAINT realm_discovery_operation_check3 CHECK (((NOT projected) OR (phase = ANY (ARRAY['applied'::text, 'aborted'::text])))),
    CONSTRAINT realm_discovery_operation_effect_check CHECK ((effect = ANY (ARRAY['retract'::text, 'restore'::text]))),
    CONSTRAINT realm_discovery_operation_generation_check CHECK ((generation > 0)),
    CONSTRAINT realm_discovery_operation_intent_check CHECK ((intent ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT realm_discovery_operation_native_version_check CHECK ((native_version > 0)),
    CONSTRAINT realm_discovery_operation_phase_check CHECK ((phase = ANY (ARRAY['prepared'::text, 'ready'::text, 'applied'::text, 'aborted'::text]))),
    CONSTRAINT realm_discovery_operation_realm_epoch_check CHECK ((realm_epoch > 0)),
    CONSTRAINT realm_discovery_operation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_discovery_operation_source_version_check CHECK ((source_version >= 0)),
    CONSTRAINT realm_discovery_operation_target_kind_check CHECK ((target_kind = ANY (ARRAY['board'::text, 'thread'::text, 'post'::text])))
);


--
-- Name: realm_subject_candidate; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_subject_candidate (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    original_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    opening_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    board_id uuid NOT NULL,
    kind text NOT NULL,
    terminal_id uuid,
    identity_epoch bigint,
    active boolean NOT NULL,
    live boolean NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    CONSTRAINT realm_subject_candidate_check CHECK (((terminal_id IS NULL) = (identity_epoch IS NULL))),
    CONSTRAINT realm_subject_candidate_identity_epoch_check CHECK (((identity_epoch IS NULL) OR (identity_epoch >= 0))),
    CONSTRAINT realm_subject_candidate_kind_check CHECK ((kind = ANY (ARRAY['discussion'::text, 'review'::text]))),
    CONSTRAINT realm_subject_candidate_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT realm_subject_candidate_source_position_check CHECK ((source_position >= 0))
);


--
-- Name: realm_subject_census; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_subject_census (
    route integer NOT NULL,
    generation uuid DEFAULT gen_random_uuid() NOT NULL,
    cut_epoch integer NOT NULL,
    cut_position bigint NOT NULL,
    upper_id uuid,
    after_id uuid,
    pending jsonb,
    ordinal integer DEFAULT 0 NOT NULL,
    exhausted boolean DEFAULT false NOT NULL,
    CONSTRAINT realm_subject_census_cut_epoch_check CHECK ((cut_epoch > 0)),
    CONSTRAINT realm_subject_census_cut_position_check CHECK ((cut_position >= 0)),
    CONSTRAINT realm_subject_census_ordinal_check CHECK (((ordinal >= 0) AND (ordinal <= 128))),
    CONSTRAINT realm_subject_census_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: realm_subject_generation; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_subject_generation (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    generation uuid DEFAULT gen_random_uuid() NOT NULL,
    revision bigint DEFAULT 0 NOT NULL,
    unresolved bigint DEFAULT 0 NOT NULL,
    CONSTRAINT realm_subject_generation_revision_check CHECK ((revision >= 0)),
    CONSTRAINT realm_subject_generation_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_subject_generation_unresolved_check CHECK ((unresolved >= 0))
);


--
-- Name: realm_subject_identity_work; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_subject_identity_work (
    route integer NOT NULL,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    event_id uuid NOT NULL,
    original_id uuid NOT NULL,
    after_route integer DEFAULT '-1'::integer NOT NULL,
    after_realm_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    after_thread_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    CONSTRAINT realm_subject_identity_work_after_route_check CHECK (((after_route >= '-1'::integer) AND (after_route <= 65535))),
    CONSTRAINT realm_subject_identity_work_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_subject_identity_work_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT realm_subject_identity_work_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095))),
    CONSTRAINT realm_subject_identity_work_source_position_check CHECK ((source_position > 0))
);


--
-- Name: realm_subject_scope_event; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_subject_scope_event (
    route integer NOT NULL,
    scope_kind text NOT NULL,
    scope_id uuid NOT NULL,
    source_partition integer NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    event_id uuid NOT NULL,
    CONSTRAINT realm_subject_scope_event_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_subject_scope_event_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['realm'::text, 'space'::text, 'realm-board-set'::text]))),
    CONSTRAINT realm_subject_scope_event_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT realm_subject_scope_event_source_partition_check CHECK (((source_partition >= 0) AND (source_partition <= 4095))),
    CONSTRAINT realm_subject_scope_event_source_position_check CHECK ((source_position > 0))
);


--
-- Name: realm_subject_scope_state; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_subject_scope_state (
    route integer NOT NULL,
    scope_kind text NOT NULL,
    scope_id uuid NOT NULL,
    generation bigint NOT NULL,
    CONSTRAINT realm_subject_scope_state_generation_check CHECK ((generation > 0)),
    CONSTRAINT realm_subject_scope_state_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT realm_subject_scope_state_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['realm'::text, 'space'::text, 'realm-board-set'::text])))
);


--
-- Name: realm_subject_sweep_state; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_subject_sweep_state (
    singleton boolean DEFAULT true NOT NULL,
    generation uuid DEFAULT gen_random_uuid() NOT NULL,
    next_route integer DEFAULT 0 NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    CONSTRAINT realm_subject_sweep_state_check CHECK (((complete AND (next_route = 65536)) OR ((NOT complete) AND (next_route < 65536)))),
    CONSTRAINT realm_subject_sweep_state_next_route_check CHECK (((next_route >= 0) AND (next_route <= 65536))),
    CONSTRAINT realm_subject_sweep_state_singleton_check CHECK (singleton)
);


--
-- Name: realm_subject_thread_fence; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.realm_subject_thread_fence (
    route integer NOT NULL,
    realm_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    CONSTRAINT realm_subject_thread_fence_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT realm_subject_thread_fence_source_position_check CHECK ((source_position > 0))
);


--
-- Name: report; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.report (
    route integer NOT NULL,
    report_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    revision_id uuid,
    reason text NOT NULL,
    evidence text,
    reporter_account_id uuid,
    created_at timestamp with time zone NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    recorded_xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    outcome text,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    decision_id uuid,
    reporter_erased boolean DEFAULT false NOT NULL,
    CONSTRAINT report_check CHECK ((route = ((get_byte(uuid_send(report_id), 10) * 256) + get_byte(uuid_send(report_id), 11)))),
    CONSTRAINT report_check1 CHECK (((octet_length(reason) + COALESCE(octet_length(evidence), 0)) <= 2097152)),
    CONSTRAINT report_check2 CHECK (((revision_id IS NULL) OR (target_kind <> ALL (ARRAY['board'::text, 'subject'::text])))),
    CONSTRAINT report_evidence_check CHECK ((char_length(evidence) <= 4096)),
    CONSTRAINT report_outcome_shape CHECK ((((outcome IS NULL) AND (resolved_at IS NULL) AND (resolved_by IS NULL) AND (decision_id IS NULL)) OR ((outcome IS NOT NULL) AND (outcome = ANY (ARRAY['actioned'::text, 'dismissed'::text])) AND (resolved_at IS NOT NULL) AND (((outcome = 'actioned'::text) AND (((target_kind = 'subject'::text) AND (decision_id IS NULL)) OR ((target_kind <> 'subject'::text) AND (decision_id IS NOT NULL)))) OR ((outcome = 'dismissed'::text) AND (decision_id IS NULL) AND (resolved_by IS NOT NULL)))))),
    CONSTRAINT report_reason_check CHECK ((reason = ANY (ARRAY['off_topic'::text, 'inappropriate'::text, 'spam'::text, 'illegal'::text, 'other'::text]))),
    CONSTRAINT report_reporter_account_id_check CHECK (((reporter_account_id IS NULL) OR (reporter_account_id <> '00000000-0000-0000-0000-000000000000'::uuid))),
    CONSTRAINT report_reporter_erased_shape CHECK (((NOT reporter_erased) OR ((reporter_account_id IS NULL) AND (evidence IS NULL)))),
    CONSTRAINT report_required_evidence CHECK ((reporter_erased OR (reason <> ALL (ARRAY['illegal'::text, 'other'::text])) OR ((evidence IS NOT NULL) AND (char_length(evidence) > 0)))),
    CONSTRAINT report_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT report_target_kind_check CHECK ((target_kind = ANY (ARRAY['board'::text, 'thread'::text, 'post'::text, 'subject'::text])))
);


--
-- Name: report_outcome_delivery; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.report_outcome_delivery (
    route integer NOT NULL,
    recipient_id uuid NOT NULL,
    report_id uuid NOT NULL,
    CONSTRAINT report_outcome_delivery_check CHECK ((route = ((get_byte(uuid_send(recipient_id), 10) * 256) + get_byte(uuid_send(recipient_id), 11)))),
    CONSTRAINT report_outcome_delivery_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: report_outcome_work; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.report_outcome_work (
    route integer NOT NULL,
    decision_id uuid NOT NULL,
    after_at timestamp with time zone NOT NULL,
    after_id uuid NOT NULL,
    done boolean NOT NULL,
    CONSTRAINT report_outcome_work_check CHECK ((route = ((get_byte(uuid_send(decision_id), 10) * 256) + get_byte(uuid_send(decision_id), 11)))),
    CONSTRAINT report_outcome_work_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: report_reporter; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.report_reporter (
    route integer NOT NULL,
    reporter_account_id uuid NOT NULL,
    report_route integer NOT NULL,
    report_id uuid NOT NULL,
    CONSTRAINT report_reporter_check CHECK ((route = ((get_byte(uuid_send(reporter_account_id), 10) * 256) + get_byte(uuid_send(reporter_account_id), 11)))),
    CONSTRAINT report_reporter_check1 CHECK ((report_route = ((get_byte(uuid_send(report_id), 10) * 256) + get_byte(uuid_send(report_id), 11)))),
    CONSTRAINT report_reporter_report_route_check CHECK (((report_route >= 0) AND (report_route <= 65535))),
    CONSTRAINT report_reporter_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: report_target; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.report_target (
    route integer NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    report_route integer NOT NULL,
    report_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT report_target_check CHECK ((route = ((get_byte(uuid_send(target_id), 10) * 256) + get_byte(uuid_send(target_id), 11)))),
    CONSTRAINT report_target_check1 CHECK ((report_route = ((get_byte(uuid_send(report_id), 10) * 256) + get_byte(uuid_send(report_id), 11)))),
    CONSTRAINT report_target_report_route_check CHECK (((report_route >= 0) AND (report_route <= 65535))),
    CONSTRAINT report_target_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT report_target_target_kind_check CHECK ((target_kind = ANY (ARRAY['board'::text, 'thread'::text, 'post'::text, 'subject'::text])))
);


--
-- Name: review_discovery_change; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.review_discovery_change (
    route integer NOT NULL,
    thread_id uuid NOT NULL,
    partition_no integer NOT NULL,
    "position" bigint NOT NULL,
    origin jsonb NOT NULL,
    origin_id uuid NOT NULL,
    CONSTRAINT review_discovery_change_check CHECK ((partition_no = (route / 16))),
    CONSTRAINT review_discovery_change_check1 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT review_discovery_change_check2 CHECK (((origin ->> 'id'::text) = (origin_id)::text)),
    CONSTRAINT review_discovery_change_position_check CHECK (("position" > 0)),
    CONSTRAINT review_discovery_change_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: review_discovery_dependency; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.review_discovery_dependency (
    route integer NOT NULL,
    thread_id uuid NOT NULL,
    gate_kind text NOT NULL,
    gate_key uuid NOT NULL,
    CONSTRAINT review_discovery_dependency_check CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT review_discovery_dependency_gate_kind_check CHECK ((gate_kind = ANY (ARRAY['thread'::text, 'post'::text, 'board'::text, 'subject'::text, 'account'::text, 'realm'::text, 'space'::text, 'context'::text]))),
    CONSTRAINT review_discovery_dependency_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: review_discovery_frontier; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.review_discovery_frontier (
    route integer NOT NULL,
    "position" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT review_discovery_frontier_position_check CHECK (("position" >= 0)),
    CONSTRAINT review_discovery_frontier_route_check CHECK ((((route >= 0) AND (route <= 65535)) AND ((route % 16) = 0)))
);


--
-- Name: review_discovery_work; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.review_discovery_work (
    route integer NOT NULL,
    id uuid NOT NULL,
    origin jsonb NOT NULL,
    scopes jsonb NOT NULL,
    scope_no integer DEFAULT 0 NOT NULL,
    after_route integer DEFAULT '-1'::integer NOT NULL,
    after_id uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    source_subject uuid,
    after_subject uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
    version bigint DEFAULT 1 NOT NULL,
    complete boolean DEFAULT false NOT NULL,
    CONSTRAINT review_discovery_work_after_route_check CHECK (((after_route >= '-1'::integer) AND (after_route <= 65535))),
    CONSTRAINT review_discovery_work_route_check CHECK ((((route >= 0) AND (route <= 65535)) AND ((route % 16) = 0))),
    CONSTRAINT review_discovery_work_scope_no_check CHECK (((scope_no >= 0) AND (scope_no <= 8))),
    CONSTRAINT review_discovery_work_scopes_check CHECK (((jsonb_typeof(scopes) = 'array'::text) AND ((jsonb_array_length(scopes) >= 1) AND (jsonb_array_length(scopes) <= 8)))),
    CONSTRAINT review_discovery_work_version_check CHECK ((version > 0))
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
    body_sha256 bytea,
    search_text text,
    licence text NOT NULL,
    subject_ids uuid[] NOT NULL,
    board_id uuid NOT NULL,
    availability text NOT NULL,
    recorded_transaction_id uuid NOT NULL,
    recorded_at timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
    media_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    vote_citation jsonb,
    CONSTRAINT revision_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'erased'::text]))),
    CONSTRAINT revision_body_sha256_check CHECK ((octet_length(body_sha256) = 32)),
    CONSTRAINT revision_body_sha256_matches CHECK ((NOT (body_sha256 IS DISTINCT FROM sha256(body)))),
    CONSTRAINT revision_body_size_limit CHECK ((octet_length(body) <= 2097152)),
    CONSTRAINT revision_check CHECK ((route = ((get_byte(uuid_send(revision_id), 10) * 256) + get_byte(uuid_send(revision_id), 11)))),
    CONSTRAINT revision_check1 CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT revision_check2 CHECK ((route = ((get_byte(uuid_send(post_id), 10) * 256) + get_byte(uuid_send(post_id), 11)))),
    CONSTRAINT revision_check3 CHECK ((((availability = 'erased'::text) AND (body IS NULL) AND (search_text IS NULL)) OR ((availability = 'available'::text) AND (body IS NOT NULL) AND (search_text IS NOT NULL)))),
    CONSTRAINT revision_licence_size CHECK ((((char_length(licence) >= 1) AND (char_length(licence) <= 128)) AND ((licence ~ '^[A-Za-z0-9.+-]+$'::text) OR (licence ~ '^LicenseRef-[A-Za-z0-9.-]+$'::text)))),
    CONSTRAINT revision_media_ids_limit CHECK ((cardinality(media_ids) <= 32)),
    CONSTRAINT revision_media_routes_check CHECK (content.media_routes_match(route, media_ids)),
    CONSTRAINT revision_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT revision_subject_ids_limit CHECK ((cardinality(subject_ids) <= 128)),
    CONSTRAINT revision_vote_citation_check CHECK (((vote_citation IS NULL) OR ((jsonb_typeof(vote_citation) = 'object'::text) AND (vote_citation ?& ARRAY['questionId'::text, 'units'::text, 'revision'::text]) AND ((vote_citation - ARRAY['questionId'::text, 'units'::text, 'revision'::text]) = '{}'::jsonb) AND (jsonb_typeof((vote_citation -> 'questionId'::text)) = 'string'::text) AND ((vote_citation ->> 'questionId'::text) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND (jsonb_typeof((vote_citation -> 'units'::text)) = 'number'::text) AND ((vote_citation ->> 'units'::text) ~ '^(0|[1-9][0-9]*)$'::text) AND ((((vote_citation ->> 'units'::text))::numeric >= (0)::numeric) AND (((vote_citation ->> 'units'::text))::numeric <= (4096)::numeric)) AND (jsonb_typeof((vote_citation -> 'revision'::text)) = 'number'::text) AND ((vote_citation ->> 'revision'::text) ~ '^[1-9][0-9]*$'::text) AND (((vote_citation ->> 'revision'::text))::numeric <= (2147483647)::numeric))))
)
WITH (fillfactor='50');
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
    taken_down_at timestamp with time zone,
    takedown_id uuid,
    CONSTRAINT source_fences_external_id_check CHECK ((((octet_length(external_id) >= 1) AND (octet_length(external_id) <= 1024)) AND (external_id !~ '[\u0001-\u001f\u007f-\u009f]'::text))),
    CONSTRAINT source_fences_field_group_check CHECK ((field_group = ANY (ARRAY['facts'::text, 'summary'::text, 'cover'::text]))),
    CONSTRAINT source_fences_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT source_fences_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT source_fences_source_check CHECK ((source ~ '^[a-z][a-z0-9_-]{0,31}$'::text))
);


--
-- Name: subject_reactor; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.subject_reactor (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    actor_account_id uuid NOT NULL,
    kind text NOT NULL,
    CONSTRAINT subject_reactor_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_reactor_kind_check CHECK ((kind = ANY (ARRAY['like'::text, 'love'::text, 'laugh'::text, 'insightful'::text, 'sad'::text]))),
    CONSTRAINT subject_reactor_route_check CHECK (((route >= 0) AND (route <= 65535)))
);


--
-- Name: subject_report_action; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.subject_report_action (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    security_revision bigint NOT NULL,
    action_id uuid NOT NULL,
    decided_at timestamp with time zone NOT NULL,
    CONSTRAINT subject_report_action_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_report_action_check1 CHECK ((route = ((get_byte(uuid_send(action_id), 10) * 256) + get_byte(uuid_send(action_id), 11)))),
    CONSTRAINT subject_report_action_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_report_action_security_revision_check CHECK ((security_revision > 0))
);


--
-- Name: subject_thread; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.subject_thread (
    route integer NOT NULL,
    subject_id uuid NOT NULL,
    thread_route integer NOT NULL,
    thread_id uuid NOT NULL,
    place_id uuid NOT NULL,
    kind text NOT NULL,
    last_activity_at timestamp with time zone NOT NULL,
    source_epoch integer NOT NULL,
    source_position bigint NOT NULL,
    CONSTRAINT subject_thread_check CHECK ((route = ((get_byte(uuid_send(subject_id), 10) * 256) + get_byte(uuid_send(subject_id), 11)))),
    CONSTRAINT subject_thread_kind_check CHECK ((kind = ANY (ARRAY['discussion'::text, 'review'::text]))),
    CONSTRAINT subject_thread_last_activity_finite CHECK (isfinite(last_activity_at)),
    CONSTRAINT subject_thread_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT subject_thread_source_epoch_check CHECK ((source_epoch > 0)),
    CONSTRAINT subject_thread_source_position_check CHECK ((source_position > 0)),
    CONSTRAINT subject_thread_thread_route_check CHECK ((thread_route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT subject_thread_thread_route_range_check CHECK (((thread_route >= 0) AND (thread_route <= 65535)))
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
    kind text DEFAULT 'discussion'::text NOT NULL,
    review_subject_id uuid,
    review_live boolean DEFAULT true NOT NULL,
    CONSTRAINT thread_availability_check CHECK ((availability = ANY (ARRAY['available'::text, 'erased'::text]))),
    CONSTRAINT thread_check CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11)))),
    CONSTRAINT thread_kind_check CHECK ((kind = ANY (ARRAY['discussion'::text, 'review'::text]))),
    CONSTRAINT thread_review_route_check CHECK (((kind <> 'review'::text) OR (route = ((get_byte(uuid_send(author_account_id), 10) * 256) + get_byte(uuid_send(author_account_id), 11))))),
    CONSTRAINT thread_review_subject_check CHECK ((((kind = 'review'::text) AND (review_subject_id IS NOT NULL)) OR ((kind = 'discussion'::text) AND (review_subject_id IS NULL)))),
    CONSTRAINT thread_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT thread_security_revision_check CHECK ((security_revision > 0)),
    CONSTRAINT thread_title_size CHECK (((title IS NULL) OR ((char_length(title) >= 1) AND (char_length(title) <= 1024)))),
    CONSTRAINT thread_visibility_check CHECK ((visibility = ANY (ARRAY['published'::text, 'draft'::text, 'protected'::text, 'taken_down'::text])))
);


--
-- Name: thread_watch; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.thread_watch (
    route integer NOT NULL,
    watch_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    watcher_account_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT thread_watch_created_at_check CHECK (isfinite(created_at)),
    CONSTRAINT thread_watch_id_route_check CHECK ((route = ((get_byte(uuid_send(watch_id), 10) * 256) + get_byte(uuid_send(watch_id), 11)))),
    CONSTRAINT thread_watch_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT thread_watch_watcher_route_check CHECK ((route = ((get_byte(uuid_send(watcher_account_id), 10) * 256) + get_byte(uuid_send(watcher_account_id), 11))))
);


--
-- Name: thread_watch_notice_work; Type: TABLE; Schema: content; Owner: -
--

CREATE TABLE content.thread_watch_notice_work (
    route integer NOT NULL,
    post_id uuid NOT NULL,
    thread_id uuid NOT NULL,
    published_at timestamp with time zone NOT NULL,
    cursor_created_at timestamp with time zone,
    cursor_route integer,
    cursor_watch_id uuid,
    done boolean DEFAULT false NOT NULL,
    CONSTRAINT thread_watch_notice_work_cursor_check CHECK ((((cursor_created_at IS NULL) = (cursor_route IS NULL)) AND ((cursor_route IS NULL) = (cursor_watch_id IS NULL)))),
    CONSTRAINT thread_watch_notice_work_cursor_route_check CHECK (((cursor_route IS NULL) OR ((cursor_route >= 0) AND (cursor_route <= 65535)))),
    CONSTRAINT thread_watch_notice_work_cursor_watch_route_check CHECK (((cursor_watch_id IS NULL) OR (cursor_route = ((get_byte(uuid_send(cursor_watch_id), 10) * 256) + get_byte(uuid_send(cursor_watch_id), 11))))),
    CONSTRAINT thread_watch_notice_work_post_route_check CHECK ((route = ((get_byte(uuid_send(post_id), 10) * 256) + get_byte(uuid_send(post_id), 11)))),
    CONSTRAINT thread_watch_notice_work_published_at_check CHECK (isfinite(published_at)),
    CONSTRAINT thread_watch_notice_work_route_check CHECK (((route >= 0) AND (route <= 65535))),
    CONSTRAINT thread_watch_notice_work_thread_route_check CHECK ((route = ((get_byte(uuid_send(thread_id), 10) * 256) + get_byte(uuid_send(thread_id), 11))))
);


--
-- Name: account_erasure_progress account_erasure_progress_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.account_erasure_progress
    ADD CONSTRAINT account_erasure_progress_pkey PRIMARY KEY (route, account_id);


--
-- Name: account_erasure_statement account_erasure_statement_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.account_erasure_statement
    ADD CONSTRAINT account_erasure_statement_pkey PRIMARY KEY (route, account_id, due_at, decision_id);


--
-- Name: account_upload account_upload_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.account_upload
    ADD CONSTRAINT account_upload_pkey PRIMARY KEY (route, account_id, phase, id);


--
-- Name: author_item author_item_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.author_item
    ADD CONSTRAINT author_item_pkey PRIMARY KEY (route, author_account_id, item_kind, item_id);


--
-- Name: authored_field authored_field_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.authored_field
    ADD CONSTRAINT authored_field_pkey PRIMARY KEY (route, id);


--
-- Name: authored_field_purge authored_field_purge_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.authored_field_purge
    ADD CONSTRAINT authored_field_purge_pkey PRIMARY KEY (route, document_id);


--
-- Name: board board_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board
    ADD CONSTRAINT board_pkey PRIMARY KEY (route, board_id);


--
-- Name: board board_realm_subject_unique; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board
    ADD CONSTRAINT board_realm_subject_unique UNIQUE (route, realm_id, subject_id);


--
-- Name: board_report_candidate board_report_candidate_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_report_candidate
    ADD CONSTRAINT board_report_candidate_pkey PRIMARY KEY (route, board_id, report_id);


--
-- Name: board_slow_actor board_slow_actor_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_slow_actor
    ADD CONSTRAINT board_slow_actor_pkey PRIMARY KEY (route, board_id, actor_key);


--
-- Name: board_slow_mode board_slow_mode_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_slow_mode
    ADD CONSTRAINT board_slow_mode_pkey PRIMARY KEY (route, board_id);


--
-- Name: board_thread board_thread_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_thread
    ADD CONSTRAINT board_thread_pkey PRIMARY KEY (route, board_id, thread_id);


--
-- Name: board_watch_notice_work board_watch_notice_work_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_watch_notice_work
    ADD CONSTRAINT board_watch_notice_work_pkey PRIMARY KEY (route, post_id);


--
-- Name: board_watch board_watch_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_watch
    ADD CONSTRAINT board_watch_pkey PRIMARY KEY (route, watcher_account_id, board_id);


--
-- Name: board_watch board_watch_route_watch_id_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_watch
    ADD CONSTRAINT board_watch_route_watch_id_key UNIQUE (route, watch_id);


--
-- Name: catalogue_report_candidate catalogue_report_candidate_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.catalogue_report_candidate
    ADD CONSTRAINT catalogue_report_candidate_pkey PRIMARY KEY (route, report_id);


--
-- Name: creator_edition creator_edition_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.creator_edition
    ADD CONSTRAINT creator_edition_pkey PRIMARY KEY (route, creator_account_id, edition_id);


--
-- Name: edition edition_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.edition
    ADD CONSTRAINT edition_pkey PRIMARY KEY (route, edition_id);


--
-- Name: edition_publication edition_publication_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.edition_publication
    ADD CONSTRAINT edition_publication_pkey PRIMARY KEY (route, operation_id);


--
-- Name: edition_publication edition_publication_route_edition_id_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.edition_publication
    ADD CONSTRAINT edition_publication_route_edition_id_key UNIQUE (route, edition_id);


--
-- Name: erasure_fence erasure_fence_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.erasure_fence
    ADD CONSTRAINT erasure_fence_pkey PRIMARY KEY (route, account_id);


--
-- Name: feed_activity feed_activity_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.feed_activity
    ADD CONSTRAINT feed_activity_pkey PRIMARY KEY (route, target_type, target_id, activity_id);


--
-- Name: feed_inbox feed_inbox_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.feed_inbox
    ADD CONSTRAINT feed_inbox_pkey PRIMARY KEY (route, account_id, activity_id);


--
-- Name: imported_field imported_field_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.imported_field
    ADD CONSTRAINT imported_field_pkey PRIMARY KEY (route, id);


--
-- Name: media media_image_display_metadata_check; Type: CHECK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE content.media
    ADD CONSTRAINT media_image_display_metadata_check CHECK (((purpose <> 'cover'::text) OR (state <> 'available'::text) OR ((width IS NOT NULL) AND (width > 0) AND (height IS NOT NULL) AND (height > 0) AND (thumbhash IS NOT NULL) AND (octet_length(thumbhash) <= 32) AND (average_color IS NOT NULL) AND (average_color ~ '^#[0-9a-f]{6}$'::text)))) NOT VALID;


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
-- Name: moderation_appeal_board moderation_appeal_board_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.moderation_appeal_board
    ADD CONSTRAINT moderation_appeal_board_pkey PRIMARY KEY (route, board_id, appeal_id);


--
-- Name: moderation_appeal moderation_appeal_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.moderation_appeal
    ADD CONSTRAINT moderation_appeal_pkey PRIMARY KEY (route, appeal_id);


--
-- Name: moderation_appeal moderation_appeal_route_decision_id_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.moderation_appeal
    ADD CONSTRAINT moderation_appeal_route_decision_id_key UNIQUE (route, decision_id);


--
-- Name: moderation_decision moderation_decision_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.moderation_decision
    ADD CONSTRAINT moderation_decision_pkey PRIMARY KEY (route, decision_id);


--
-- Name: moderation_decision moderation_decision_route_target_kind_target_id_security_re_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.moderation_decision
    ADD CONSTRAINT moderation_decision_route_target_kind_target_id_security_re_key UNIQUE (route, target_kind, target_id, security_revision);


--
-- Name: notice_finalization notice_finalization_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.notice_finalization
    ADD CONSTRAINT notice_finalization_pkey PRIMARY KEY (route, recipient_id, kind, source_id);


--
-- Name: notice notice_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.notice
    ADD CONSTRAINT notice_pkey PRIMARY KEY (route, notice_id);


--
-- Name: notice_seen notice_seen_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.notice_seen
    ADD CONSTRAINT notice_seen_pkey PRIMARY KEY (route, account_id);


--
-- Name: operation operation_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.operation
    ADD CONSTRAINT operation_pkey PRIMARY KEY (route, operation_id);


--
-- Name: party_locator party_locator_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.party_locator
    ADD CONSTRAINT party_locator_pkey PRIMARY KEY (route, account_id, kind, due_at, owner_id);


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
-- Name: reaction_contribution reaction_contribution_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.reaction_contribution
    ADD CONSTRAINT reaction_contribution_pkey PRIMARY KEY (route, target_id, actor_account_id);


--
-- Name: reaction_count reaction_count_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.reaction_count
    ADD CONSTRAINT reaction_count_pkey PRIMARY KEY (route, target_id, source_partition, kind);


--
-- Name: reaction_liked_version reaction_liked_version_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.reaction_liked_version
    ADD CONSTRAINT reaction_liked_version_pkey PRIMARY KEY (route, actor_account_id);


--
-- Name: reaction reaction_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.reaction
    ADD CONSTRAINT reaction_pkey PRIMARY KEY (route, actor_account_id, target_id);


--
-- Name: reaction_projection_baseline reaction_projection_baseline_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.reaction_projection_baseline
    ADD CONSTRAINT reaction_projection_baseline_pkey PRIMARY KEY (source_partition);


--
-- Name: reaction_total reaction_total_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.reaction_total
    ADD CONSTRAINT reaction_total_pkey PRIMARY KEY (route, target_id, kind);


--
-- Name: realm_discovery_contribution realm_discovery_contribution_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_discovery_contribution
    ADD CONSTRAINT realm_discovery_contribution_pkey PRIMARY KEY (route, thread_id);


--
-- Name: realm_discovery_operation realm_discovery_operation_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_discovery_operation
    ADD CONSTRAINT realm_discovery_operation_pkey PRIMARY KEY (route, intent, generation);


--
-- Name: realm_subject_candidate realm_subject_candidate_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_subject_candidate
    ADD CONSTRAINT realm_subject_candidate_pkey PRIMARY KEY (route, realm_id, original_id, thread_id);


--
-- Name: realm_subject_census realm_subject_census_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_subject_census
    ADD CONSTRAINT realm_subject_census_pkey PRIMARY KEY (route);


--
-- Name: realm_subject_generation realm_subject_generation_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_subject_generation
    ADD CONSTRAINT realm_subject_generation_pkey PRIMARY KEY (route, realm_id);


--
-- Name: realm_subject_identity_work realm_subject_identity_work_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_subject_identity_work
    ADD CONSTRAINT realm_subject_identity_work_pkey PRIMARY KEY (route, source_partition, source_epoch, source_position, event_id);


--
-- Name: realm_subject_scope_event realm_subject_scope_event_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_subject_scope_event
    ADD CONSTRAINT realm_subject_scope_event_pkey PRIMARY KEY (route, scope_kind, scope_id, source_partition, source_epoch, source_position, event_id);


--
-- Name: realm_subject_scope_state realm_subject_scope_state_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_subject_scope_state
    ADD CONSTRAINT realm_subject_scope_state_pkey PRIMARY KEY (route, scope_kind, scope_id);


--
-- Name: realm_subject_sweep_state realm_subject_sweep_state_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_subject_sweep_state
    ADD CONSTRAINT realm_subject_sweep_state_pkey PRIMARY KEY (singleton);


--
-- Name: realm_subject_thread_fence realm_subject_thread_fence_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_subject_thread_fence
    ADD CONSTRAINT realm_subject_thread_fence_pkey PRIMARY KEY (route, realm_id, thread_id);


--
-- Name: report_outcome_delivery report_outcome_delivery_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.report_outcome_delivery
    ADD CONSTRAINT report_outcome_delivery_pkey PRIMARY KEY (route, recipient_id, report_id);


--
-- Name: report_outcome_work report_outcome_work_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.report_outcome_work
    ADD CONSTRAINT report_outcome_work_pkey PRIMARY KEY (route, decision_id);


--
-- Name: report report_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.report
    ADD CONSTRAINT report_pkey PRIMARY KEY (route, report_id);


--
-- Name: report_reporter report_reporter_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.report_reporter
    ADD CONSTRAINT report_reporter_pkey PRIMARY KEY (route, reporter_account_id, report_id);


--
-- Name: report_target report_target_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.report_target
    ADD CONSTRAINT report_target_pkey PRIMARY KEY (route, target_kind, target_id, report_route, report_id);


--
-- Name: review_discovery_change review_discovery_change_partition_no_position_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.review_discovery_change
    ADD CONSTRAINT review_discovery_change_partition_no_position_key UNIQUE (partition_no, "position");


--
-- Name: review_discovery_change review_discovery_change_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.review_discovery_change
    ADD CONSTRAINT review_discovery_change_pkey PRIMARY KEY (route, thread_id, origin_id);


--
-- Name: review_discovery_dependency review_discovery_dependency_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.review_discovery_dependency
    ADD CONSTRAINT review_discovery_dependency_pkey PRIMARY KEY (route, thread_id, gate_kind, gate_key);


--
-- Name: review_discovery_frontier review_discovery_frontier_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.review_discovery_frontier
    ADD CONSTRAINT review_discovery_frontier_pkey PRIMARY KEY (route);


--
-- Name: review_discovery_work review_discovery_work_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.review_discovery_work
    ADD CONSTRAINT review_discovery_work_pkey PRIMARY KEY (route, id);


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
-- Name: subject_reactor subject_reactor_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.subject_reactor
    ADD CONSTRAINT subject_reactor_pkey PRIMARY KEY (route, subject_id, actor_account_id);


--
-- Name: subject_report_action subject_report_action_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.subject_report_action
    ADD CONSTRAINT subject_report_action_pkey PRIMARY KEY (route, subject_id);


--
-- Name: subject_thread subject_thread_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.subject_thread
    ADD CONSTRAINT subject_thread_pkey PRIMARY KEY (route, subject_id, thread_id);


--
-- Name: thread thread_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.thread
    ADD CONSTRAINT thread_pkey PRIMARY KEY (route, thread_id);


--
-- Name: thread_watch thread_watch_identity_key; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.thread_watch
    ADD CONSTRAINT thread_watch_identity_key UNIQUE (route, thread_id, watcher_account_id);


--
-- Name: thread_watch_notice_work thread_watch_notice_work_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.thread_watch_notice_work
    ADD CONSTRAINT thread_watch_notice_work_pkey PRIMARY KEY (route, post_id);


--
-- Name: thread_watch thread_watch_pkey; Type: CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.thread_watch
    ADD CONSTRAINT thread_watch_pkey PRIMARY KEY (route, watch_id);


--
-- Name: author_item_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX author_item_page_idx ON content.author_item USING btree (route, author_account_id, item_kind, thread_kind, created_at DESC, item_id);


--
-- Name: author_item_post_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX author_item_post_page_idx ON content.author_item USING btree (route, author_account_id, created_at DESC, item_id) WHERE (item_kind = 'post'::text);


--
-- Name: board_global_directory_page; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_global_directory_page ON content.board USING btree (route, board_id) WHERE ((realm_id IS NULL) AND (visibility = 'published'::text));


--
-- Name: board_global_directory_purpose_page; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_global_directory_purpose_page ON content.board USING btree (purpose, route, board_id) WHERE ((realm_id IS NULL) AND (visibility = 'published'::text));


--
-- Name: board_one_realm_reviews_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE UNIQUE INDEX board_one_realm_reviews_idx ON content.board USING btree (route, realm_id) WHERE ((realm_id IS NOT NULL) AND (purpose = 'reviews'::text));


--
-- Name: board_realm_page; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_realm_page ON content.board USING btree (route, realm_id, board_id DESC) WHERE (realm_id IS NOT NULL);


--
-- Name: board_report_candidate_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_report_candidate_page_idx ON content.board_report_candidate USING btree (route, board_id, created_at DESC, report_id DESC) INCLUDE (report_route, target_kind, target_id);


--
-- Name: board_thread_active_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_thread_active_page_idx ON content.board_thread USING btree (route, board_id, active_rank DESC, thread_id);


--
-- Name: board_thread_hot_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_thread_hot_page_idx ON content.board_thread USING btree (route, board_id, hot_rank DESC, thread_id);


--
-- Name: board_thread_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_thread_page_idx ON content.board_thread USING btree (route, board_id, created_at, thread_id);


--
-- Name: board_thread_pin_position_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE UNIQUE INDEX board_thread_pin_position_idx ON content.board_thread USING btree (route, board_id, pin_slot) INCLUDE (thread_id) WHERE (pin_slot IS NOT NULL);


--
-- Name: board_thread_rank_refresh_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_thread_rank_refresh_idx ON content.board_thread USING btree (route, rank_refreshed_at, board_id, thread_id) WHERE (active_rank <> (0)::double precision);


--
-- Name: board_watch_account_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_watch_account_idx ON content.board_watch USING btree (route, watcher_account_id, created_at, watch_id) INCLUDE (board_id, revision) WHERE watching;


--
-- Name: board_watch_fanout_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_watch_fanout_idx ON content.board_watch USING btree (board_id, created_at, watch_id) INCLUDE (route, watcher_account_id) WHERE watching;


--
-- Name: board_watch_notice_work_expire_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX board_watch_notice_work_expire_idx ON content.board_watch_notice_work USING btree (route, published_at, post_id);


--
-- Name: catalogue_report_candidate_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX catalogue_report_candidate_page_idx ON content.catalogue_report_candidate USING btree (route, created_at DESC, report_id DESC) INCLUDE (report_route, subject_id);


--
-- Name: feed_activity_expiry; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX feed_activity_expiry ON content.feed_activity USING btree (partition_no, occurred_at, route, target_type, target_id, activity_id);


--
-- Name: feed_activity_recent; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX feed_activity_recent ON content.feed_activity USING btree (route, target_type, target_id, occurred_at DESC, activity_id DESC);


--
-- Name: feed_inbox_expiry; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX feed_inbox_expiry ON content.feed_inbox USING btree (partition_no, occurred_at, route, account_id, activity_id);


--
-- Name: feed_inbox_recent; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX feed_inbox_recent ON content.feed_inbox USING btree (route, account_id, occurred_at DESC, activity_id DESC);


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
-- Name: moderation_appeal_board_pending_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX moderation_appeal_board_pending_idx ON content.moderation_appeal_board USING btree (route, board_id, created_at DESC, appeal_id DESC) WHERE pending;


--
-- Name: moderation_appeal_thread_pending_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX moderation_appeal_thread_pending_idx ON content.moderation_appeal USING btree (route, thread_id, created_at DESC, appeal_id DESC) WHERE (outcome IS NULL);


--
-- Name: notice_finalization_recipient_created_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX notice_finalization_recipient_created_idx ON content.notice_finalization USING btree (route, recipient_id, created_at, kind, source_id);


--
-- Name: notice_finalization_route_created_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX notice_finalization_route_created_idx ON content.notice_finalization USING btree (route, created_at, recipient_id, kind, source_id);


--
-- Name: notice_recipient_created_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX notice_recipient_created_idx ON content.notice USING btree (route, recipient_id, created_at DESC, notice_id DESC);


--
-- Name: notice_route_created_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX notice_route_created_idx ON content.notice USING btree (route, created_at, notice_id);


--
-- Name: notice_route_kind_source_recipient_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE UNIQUE INDEX notice_route_kind_source_recipient_idx ON content.notice USING btree (route, kind, source_id, recipient_id);


--
-- Name: post_deleted_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX post_deleted_page_idx ON content.post USING btree (route, deleted_at, post_id) WHERE ((deleted_at IS NOT NULL) AND (NOT purge_completed));


--
-- Name: post_thread_author_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX post_thread_author_page_idx ON content.post USING btree (route, thread_id, author_account_id, created_at, post_id);


--
-- Name: post_thread_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX post_thread_page_idx ON content.post USING btree (route, thread_id, created_at, post_id);


--
-- Name: reaction_liked_subject; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX reaction_liked_subject ON content.reaction USING btree (route, actor_account_id, target_id) WHERE ((target_kind = 'subject'::text) AND (kind = ANY (ARRAY['like'::text, 'love'::text])));


--
-- Name: realm_discovery_operation_recovery; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX realm_discovery_operation_recovery ON content.realm_discovery_operation USING btree (route, intent, generation) WHERE ((NOT projected) AND (phase = ANY (ARRAY['applied'::text, 'aborted'::text])));


--
-- Name: realm_subject_candidate_original; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX realm_subject_candidate_original ON content.realm_subject_candidate USING btree (original_id, route, realm_id, thread_id);


--
-- Name: realm_subject_candidate_prefix; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX realm_subject_candidate_prefix ON content.realm_subject_candidate USING btree (route, realm_id, terminal_id, original_id, thread_id) WHERE (active AND (terminal_id IS NOT NULL));


--
-- Name: realm_subject_candidate_thread; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX realm_subject_candidate_thread ON content.realm_subject_candidate USING btree (route, realm_id, thread_id, original_id);


--
-- Name: realm_subject_candidate_unresolved; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX realm_subject_candidate_unresolved ON content.realm_subject_candidate USING btree (route, realm_id, original_id, thread_id) WHERE (active AND (terminal_id IS NULL));


--
-- Name: realm_subject_identity_work_pending; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX realm_subject_identity_work_pending ON content.realm_subject_identity_work USING btree (route, source_partition, source_epoch, source_position, event_id) WHERE (NOT complete);


--
-- Name: report_target_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX report_target_page_idx ON content.report_target USING btree (route, target_kind, target_id, created_at DESC, report_id DESC) INCLUDE (report_route);


--
-- Name: review_discovery_dependency_all; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX review_discovery_dependency_all ON content.review_discovery_dependency USING btree (route, thread_id) WHERE (gate_kind = 'thread'::text);


--
-- Name: review_discovery_dependency_gate; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX review_discovery_dependency_gate ON content.review_discovery_dependency USING btree (gate_kind, gate_key, route, thread_id);


--
-- Name: review_discovery_dependency_resource; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX review_discovery_dependency_resource ON content.review_discovery_dependency USING btree (gate_key, route, thread_id);


--
-- Name: revision_post_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX revision_post_page_idx ON content.revision USING btree (route, post_id, recorded_at, revision_id);


--
-- Name: subject_thread_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX subject_thread_page_idx ON content.subject_thread USING btree (route, subject_id, place_id, kind, last_activity_at DESC, thread_id);


--
-- Name: thread_one_live_review_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE UNIQUE INDEX thread_one_live_review_idx ON content.thread USING btree (route, board_id, author_account_id, review_subject_id) WHERE ((kind = 'review'::text) AND review_live AND (availability = 'available'::text) AND (visibility <> 'taken_down'::text));


--
-- Name: thread_review_discovery_page_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX thread_review_discovery_page_idx ON content.thread USING btree (route, thread_id) WHERE ((kind = 'review'::text) AND review_live AND (availability = 'available'::text) AND (visibility = 'published'::text));


--
-- Name: thread_watch_account_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX thread_watch_account_idx ON content.thread_watch USING btree (route, watcher_account_id, created_at, thread_id) INCLUDE (watch_id);


--
-- Name: thread_watch_fanout_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX thread_watch_fanout_idx ON content.thread_watch USING btree (thread_id, created_at, watch_id) INCLUDE (route, watcher_account_id);


--
-- Name: thread_watch_management_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX thread_watch_management_idx ON content.thread_watch USING btree (route, watcher_account_id, created_at, watch_id) INCLUDE (thread_id);


--
-- Name: thread_watch_notice_work_expire_idx; Type: INDEX; Schema: content; Owner: -
--

CREATE INDEX thread_watch_notice_work_expire_idx ON content.thread_watch_notice_work USING btree (route, published_at, post_id);


--
-- Name: author_item author_item_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER author_item_identity BEFORE UPDATE ON content.author_item FOR EACH ROW EXECUTE FUNCTION content.guard_author_item();


--
-- Name: authored_field authored_field_immutable; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER authored_field_immutable BEFORE DELETE OR UPDATE ON content.authored_field FOR EACH ROW EXECUTE FUNCTION content.guard_authored_field();


--
-- Name: authored_field_purge authored_field_purge_immutable; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER authored_field_purge_immutable BEFORE DELETE OR UPDATE ON content.authored_field_purge FOR EACH ROW EXECUTE FUNCTION content.guard_authored_field_purge();


--
-- Name: board board_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER board_identity BEFORE UPDATE ON content.board FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'board_id', 'realm_id', 'subject_id', 'created_at', 'purpose');


--
-- Name: board_thread board_thread_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER board_thread_identity BEFORE UPDATE ON content.board_thread FOR EACH ROW EXECUTE FUNCTION content.guard_board_thread();


--
-- Name: edition edition_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER edition_identity BEFORE DELETE OR UPDATE ON content.edition FOR EACH ROW EXECUTE FUNCTION content.guard_edition();


--
-- Name: edition_publication edition_publication_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER edition_publication_identity BEFORE DELETE OR UPDATE ON content.edition_publication FOR EACH ROW EXECUTE FUNCTION content.guard_edition_publication();


--
-- Name: imported_field imported_field_immutable; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER imported_field_immutable BEFORE DELETE OR UPDATE ON content.imported_field FOR EACH ROW EXECUTE FUNCTION content.guard_imported_field();


--
-- Name: media media_erasure_guard; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER media_erasure_guard BEFORE DELETE OR UPDATE ON content.media FOR EACH ROW EXECUTE FUNCTION content.guard_media_erasure();


--
-- Name: media media_realm_claim_guard; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER media_realm_claim_guard BEFORE DELETE OR UPDATE ON content.media FOR EACH ROW EXECUTE FUNCTION content.guard_realm_media_claim();


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
-- Name: reaction_count reaction_count_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER reaction_count_identity BEFORE UPDATE ON content.reaction_count FOR EACH ROW EXECUTE FUNCTION content.guard_reaction_count();


--
-- Name: reaction reaction_liked_version; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER reaction_liked_version AFTER INSERT OR DELETE OR UPDATE ON content.reaction FOR EACH ROW EXECUTE FUNCTION content.bump_reaction_liked_version();


--
-- Name: reaction_total reaction_total_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER reaction_total_identity BEFORE UPDATE ON content.reaction_total FOR EACH ROW EXECUTE FUNCTION content.guard_reaction_total();


--
-- Name: report report_immutable; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER report_immutable BEFORE DELETE OR UPDATE ON content.report FOR EACH ROW EXECUTE FUNCTION content.guard_report();


--
-- Name: thread review_discovery_dependencies; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER review_discovery_dependencies AFTER INSERT OR UPDATE OF board_id, review_subject_id, first_post_id, author_account_id ON content.thread FOR EACH ROW EXECUTE FUNCTION content.record_review_discovery_dependencies();


--
-- Name: revision revision_immutable; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER revision_immutable BEFORE DELETE OR UPDATE ON content.revision FOR EACH ROW EXECUTE FUNCTION content.guard_revision();


--
-- Name: revision revision_review_contract; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER revision_review_contract BEFORE INSERT ON content.revision FOR EACH ROW EXECUTE FUNCTION content.guard_review_revision();


--
-- Name: source_fences source_fence_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER source_fence_identity BEFORE INSERT OR DELETE OR UPDATE ON content.source_fences FOR EACH ROW EXECUTE FUNCTION content.guard_source_fence();


--
-- Name: subject_thread subject_thread_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER subject_thread_identity BEFORE UPDATE ON content.subject_thread FOR EACH ROW EXECUTE FUNCTION content.guard_subject_thread();


--
-- Name: thread thread_identity; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER thread_identity BEFORE UPDATE ON content.thread FOR EACH ROW EXECUTE FUNCTION content.guard_identity('route', 'thread_id', 'author_account_id', 'board_id', 'first_post_id', 'kind', 'review_subject_id', 'created_at');


--
-- Name: thread thread_review_live; Type: TRIGGER; Schema: content; Owner: -
--

CREATE TRIGGER thread_review_live BEFORE UPDATE ON content.thread FOR EACH ROW EXECUTE FUNCTION content.guard_review_thread();


--
-- Name: authored_field_purge authored_field_purge_route_document_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.authored_field_purge
    ADD CONSTRAINT authored_field_purge_route_document_id_fkey FOREIGN KEY (route, document_id) REFERENCES content.authored_field(route, id);


--
-- Name: board board_realm_fk; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board
    ADD CONSTRAINT board_realm_fk FOREIGN KEY (route, realm_id) REFERENCES community.realm(route, realm_id);


--
-- Name: board_slow_actor board_slow_actor_route_board_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_slow_actor
    ADD CONSTRAINT board_slow_actor_route_board_id_fkey FOREIGN KEY (route, board_id) REFERENCES content.board(route, board_id) ON DELETE CASCADE;


--
-- Name: board_slow_mode board_slow_mode_route_board_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.board_slow_mode
    ADD CONSTRAINT board_slow_mode_route_board_id_fkey FOREIGN KEY (route, board_id) REFERENCES content.board(route, board_id) ON DELETE CASCADE;


--
-- Name: edition_publication edition_publication_route_edition_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.edition_publication
    ADD CONSTRAINT edition_publication_route_edition_id_fkey FOREIGN KEY (route, edition_id) REFERENCES content.edition(route, edition_id);


--
-- Name: media_variant media_variant_route_media_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.media_variant
    ADD CONSTRAINT media_variant_route_media_id_fkey FOREIGN KEY (route, media_id) REFERENCES content.media(route, media_id) ON DELETE CASCADE;


--
-- Name: moderation_appeal moderation_appeal_route_decision_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.moderation_appeal
    ADD CONSTRAINT moderation_appeal_route_decision_id_fkey FOREIGN KEY (route, decision_id) REFERENCES content.moderation_decision(route, decision_id);


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
-- Name: realm_discovery_contribution realm_discovery_contribution_route_thread_id_fkey; Type: FK CONSTRAINT; Schema: content; Owner: -
--

ALTER TABLE ONLY content.realm_discovery_contribution
    ADD CONSTRAINT realm_discovery_contribution_route_thread_id_fkey FOREIGN KEY (route, thread_id) REFERENCES content.thread(route, thread_id);


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


