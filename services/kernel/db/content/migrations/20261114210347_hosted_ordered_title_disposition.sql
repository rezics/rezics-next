-- migrate:up
CREATE INDEX hosted_version_revision_generation_kind
  ON content.hosted_version_revision(route,catalogue_id,generation_id,revision_kind);

-- The encoded product title is direct in occurrence state, and under the node's value pair.
CREATE FUNCTION content.redact_hosted_ordered_title(payload jsonb, nested boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE fields jsonb;
BEGIN
  IF payload->>'kind' IS DISTINCT FROM 'object' OR jsonb_typeof(payload->'value') IS DISTINCT FROM 'array' THEN
    RETURN payload;
  END IF;
  SELECT jsonb_agg(
    CASE
      WHEN nested AND pair->>0='value' THEN
        jsonb_build_array('value',content.redact_hosted_ordered_title(pair->1,false))
      WHEN NOT nested AND pair->>0='title' AND pair->1->>'kind'='primitive'
           AND jsonb_typeof(pair->1->'value')='string' THEN
        jsonb_build_array('title',jsonb_build_object('kind','primitive','value',NULL))
      ELSE pair
    END ORDER BY ordinal
  ) INTO fields
  FROM jsonb_array_elements(payload->'value') WITH ORDINALITY entry(pair,ordinal);
  RETURN jsonb_set(payload,'{value}',COALESCE(fields,'[]'::jsonb));
END;
$$;

ALTER TABLE content.hosted_occurrence_state_version
  ADD COLUMN title_redacted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT hosted_occurrence_private_title_tombstone CHECK (
    NOT title_redacted OR occurrence_state IS NOT DISTINCT FROM content.redact_hosted_ordered_title(occurrence_state,false)
  );
ALTER TABLE content.hosted_order_node_version
  ADD COLUMN title_redacted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT hosted_node_private_title_tombstone CHECK (
    NOT title_redacted OR node_state IS NOT DISTINCT FROM content.redact_hosted_ordered_title(node_state,true)
  );
ALTER TABLE content.hosted_version_builder_point
  ADD COLUMN title_redacted boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT hosted_builder_private_title_tombstone CHECK (NOT title_redacted OR title IS NULL);

CREATE OR REPLACE FUNCTION content.guard_hosted_version_rows() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  authority text;
  before_payload jsonb;
  after_payload jsonb;
  payload_column text;
BEGIN
  IF TG_TABLE_NAME='hosted_version_builder_point' AND TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  -- Candidate retirement retains its independent exact cleanup claim and deletion authority.
  IF TG_OP='DELETE' THEN
    authority := current_setting('content.hosted_version_candidate_cleanup',true);
    IF EXISTS (
      SELECT 1
      FROM content.hosted_version_candidate_cleanup cleanup
      JOIN content.hosted_tree_generation generation
        USING (route,catalogue_id,generation_id)
      WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
        AND cleanup.generation_id=OLD.generation_id AND generation.retirement_claimed
        AND cleanup.cleanup_active AND cleanup.completed_at IS NULL
        AND authority=cleanup.route::text||':'||cleanup.catalogue_id::text||':'||cleanup.stage_id::text||':'||cleanup.generation_id::text
    ) THEN
      RETURN OLD;
    END IF;
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.title_redacted THEN
      RAISE EXCEPTION 'Hosted ordered title tombstones require an existing title' USING ERRCODE='23514';
    END IF;
    -- Serialize all new payload rows against the native terminal marker.
    PERFORM 1 FROM content.hosted_catalogue catalogue
    JOIN content.post post
      ON post.route=catalogue.route AND post.post_id=catalogue.catalogue_id AND post.thread_id=catalogue.thread_id
    WHERE catalogue.route=NEW.route AND catalogue.catalogue_id=NEW.catalogue_id
      AND NOT ((post.availability='erased' AND post.purge_started_at IS NOT NULL)
        OR (post.availability='available' AND post.visibility='published' AND post.author_erased))
    FOR SHARE OF post;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Hosted ordered payload cannot be inserted after terminal authority' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP='UPDATE' AND TG_TABLE_NAME IN ('hosted_occurrence_state_version','hosted_order_node_version','hosted_version_builder_point') THEN
    IF TG_TABLE_NAME='hosted_version_builder_point' THEN
      IF OLD.title_redacted OR OLD.title IS NULL OR NOT NEW.title_redacted OR NEW.title IS NOT NULL
        OR (to_jsonb(NEW)-'title'-'title_redacted') IS DISTINCT FROM (to_jsonb(OLD)-'title'-'title_redacted') THEN
        RAISE EXCEPTION 'Hosted ordered payload permits only one-way title redaction' USING ERRCODE='23514';
      END IF;
    ELSE
      payload_column := CASE WHEN TG_TABLE_NAME='hosted_occurrence_state_version' THEN 'occurrence_state' ELSE 'node_state' END;
      before_payload := to_jsonb(OLD)->payload_column;
      after_payload := to_jsonb(NEW)->payload_column;
      IF OLD.title_redacted OR NOT NEW.title_redacted
        OR after_payload IS NOT DISTINCT FROM before_payload
        OR after_payload IS DISTINCT FROM content.redact_hosted_ordered_title(before_payload,TG_TABLE_NAME='hosted_order_node_version')
        OR (to_jsonb(NEW)-payload_column-'title_redacted') IS DISTINCT FROM
           (to_jsonb(OLD)-payload_column-'title_redacted') THEN
        RAISE EXCEPTION 'Hosted ordered payload permits only one-way title redaction' USING ERRCODE='23514';
      END IF;
    END IF;
    PERFORM 1 FROM content.hosted_catalogue catalogue
    JOIN content.post post
      ON post.route=catalogue.route AND post.post_id=catalogue.catalogue_id AND post.thread_id=catalogue.thread_id
    WHERE catalogue.route=OLD.route AND catalogue.catalogue_id=OLD.catalogue_id
      AND ((post.availability='erased' AND post.purge_started_at IS NOT NULL)
        OR (post.availability='available' AND post.visibility='published' AND post.author_erased))
    FOR UPDATE OF post;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Hosted ordered title disposition requires terminal native authority' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME='hosted_version_builder_point' THEN RETURN NEW; END IF;
    PERFORM 1 FROM content.hosted_tree_generation generation
    WHERE generation.route=OLD.route AND generation.catalogue_id=OLD.catalogue_id AND generation.generation_id=OLD.generation_id
    FOR UPDATE;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM content.hosted_version_revision revision
      WHERE revision.route=OLD.route AND revision.catalogue_id=OLD.catalogue_id
        AND revision.generation_id=OLD.generation_id AND revision.revision_kind='publication'
      LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Published hosted ordered labels are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Hosted version rows are append only' USING ERRCODE='23514';
END;
$$;

CREATE TRIGGER hosted_occurrence_state_terminal_insert
  BEFORE INSERT ON content.hosted_occurrence_state_version
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_version_rows();
CREATE TRIGGER hosted_order_node_terminal_insert
  BEFORE INSERT ON content.hosted_order_node_version
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_version_rows();
CREATE TRIGGER hosted_builder_private_title
  BEFORE INSERT OR UPDATE OR DELETE ON content.hosted_version_builder_point
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_version_rows();

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_occurrence_state_version WHERE title_redacted LIMIT 1)
    OR EXISTS (SELECT 1 FROM content.hosted_order_node_version WHERE title_redacted LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back retained ordered title tombstones' USING ERRCODE='23514';
  END IF;
END;
$$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_version_builder_point WHERE title_redacted LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back retained builder title tombstones' USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TRIGGER hosted_builder_private_title ON content.hosted_version_builder_point;
DROP TRIGGER hosted_occurrence_state_terminal_insert ON content.hosted_occurrence_state_version;
DROP TRIGGER hosted_order_node_terminal_insert ON content.hosted_order_node_version;
CREATE OR REPLACE FUNCTION content.guard_hosted_version_rows() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority text;
BEGIN
  IF TG_OP='DELETE' THEN
    authority := current_setting('content.hosted_version_candidate_cleanup',true);
    IF EXISTS (
      SELECT 1 FROM content.hosted_version_candidate_cleanup cleanup
      JOIN content.hosted_tree_generation generation USING (route,catalogue_id,generation_id)
      WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
        AND cleanup.generation_id=OLD.generation_id AND generation.retirement_claimed
        AND cleanup.cleanup_active AND cleanup.completed_at IS NULL
        AND authority=cleanup.route::text||':'||cleanup.catalogue_id::text||':'||cleanup.stage_id::text||':'||cleanup.generation_id::text
    ) THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'Hosted version rows are append only' USING ERRCODE='23514';
END;
$$;
ALTER TABLE content.hosted_occurrence_state_version DROP COLUMN title_redacted;
ALTER TABLE content.hosted_order_node_version DROP COLUMN title_redacted;
ALTER TABLE content.hosted_version_builder_point DROP COLUMN title_redacted;
DROP FUNCTION content.redact_hosted_ordered_title(jsonb,boolean);
DROP INDEX content.hosted_version_revision_generation_kind;
