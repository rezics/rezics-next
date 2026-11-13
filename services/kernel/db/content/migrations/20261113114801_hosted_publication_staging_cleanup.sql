-- migrate:up
-- Reclaim only private rows from an exact unsealed terminal preparation. The
-- control row and existing input/build receipts retain their existing owners.
CREATE TABLE content.hosted_publication_staging_cleanup (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  owner_epoch bigint NOT NULL CHECK (owner_epoch >= 0),
  terminal_status text NOT NULL CHECK (terminal_status IN ('cancelled', 'expired', 'failed')),
  phase text NOT NULL DEFAULT 'candidate' CHECK (phase IN ('candidate', 'input', 'target', 'done')),
  candidate_frontier bigint NOT NULL DEFAULT -1 CHECK (candidate_frontier >= -1),
  input_frontier bigint NOT NULL DEFAULT -1 CHECK (input_frontier >= -1),
  target_thread_id uuid,
  target_post_id uuid,
  target_revision_id uuid,
  target_sha256 bytea,
  deleted_row_count bigint NOT NULL DEFAULT 0 CHECK (deleted_row_count >= 0),
  cleanup_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  completed_at timestamptz CHECK (completed_at IS NULL OR isfinite(completed_at)),
  PRIMARY KEY (route, catalogue_id, stage_id),
  FOREIGN KEY (route, catalogue_id, stage_id)
    REFERENCES content.hosted_publication_staging(route, catalogue_id, stage_id),
  CHECK ((target_thread_id IS NULL AND target_post_id IS NULL AND target_revision_id IS NULL AND target_sha256 IS NULL)
      OR (target_thread_id IS NOT NULL AND target_post_id IS NOT NULL
        AND target_revision_id IS NOT NULL AND target_sha256 IS NOT NULL AND octet_length(target_sha256) = 32)),
  CHECK ((phase = 'done') = (completed_at IS NOT NULL)),
  CHECK (NOT cleanup_active OR phase <> 'done'),
  CHECK (route = get_byte(uuid_send(catalogue_id), 10) * 256 + get_byte(uuid_send(catalogue_id), 11)),
  CHECK (route = get_byte(uuid_send(stage_id), 10) * 256 + get_byte(uuid_send(stage_id), 11))
);

-- This receipt survives its data pages so a lost cleanup response is replayed
-- without moving the durable frontier a second time.
CREATE TABLE content.hosted_publication_staging_cleanup_step (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  step_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('candidate', 'input', 'target', 'done')),
  candidate_frontier bigint NOT NULL CHECK (candidate_frontier >= -1),
  input_frontier bigint NOT NULL CHECK (input_frontier >= -1),
  target_thread_id uuid,
  target_post_id uuid,
  target_revision_id uuid,
  target_sha256 bytea,
  deleted_row_count bigint NOT NULL CHECK (deleted_row_count >= 0),
  deleted_rows integer NOT NULL CHECK (deleted_rows BETWEEN 0 AND 100),
  completed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (route, catalogue_id, stage_id, step_id),
  FOREIGN KEY (route, catalogue_id, stage_id)
    REFERENCES content.hosted_publication_staging_cleanup(route, catalogue_id, stage_id),
  CHECK ((target_thread_id IS NULL AND target_post_id IS NULL AND target_revision_id IS NULL AND target_sha256 IS NULL)
      OR (target_thread_id IS NOT NULL AND target_post_id IS NOT NULL
        AND target_revision_id IS NOT NULL AND target_sha256 IS NOT NULL AND octet_length(target_sha256) = 32)),
  CHECK (completed = (phase = 'done')),
  CHECK (route = get_byte(uuid_send(step_id), 10) * 256 + get_byte(uuid_send(step_id), 11))
);

CREATE FUNCTION content.guard_hosted_publication_staging_cleanup_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stage_status text; stage_epoch bigint; stage_sealed_at timestamptz;
BEGIN
  SELECT status,owner_epoch,sealed_at INTO stage_status,stage_epoch,stage_sealed_at
  FROM content.hosted_publication_staging
  WHERE route=NEW.route AND catalogue_id=NEW.catalogue_id AND stage_id=NEW.stage_id
  FOR UPDATE;
  IF NOT FOUND OR stage_epoch IS DISTINCT FROM NEW.owner_epoch
     OR stage_status IS DISTINCT FROM NEW.terminal_status
     OR stage_status NOT IN ('cancelled','expired','failed')
     OR stage_sealed_at IS NOT NULL
     OR NEW.phase <> 'candidate' OR NEW.candidate_frontier <> -1 OR NEW.input_frontier <> -1
     OR NEW.target_thread_id IS NOT NULL OR NEW.deleted_row_count <> 0
     OR NEW.cleanup_active OR NEW.completed_at IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM content.hosted_publication_staging_seal
       WHERE route=NEW.route AND catalogue_id=NEW.catalogue_id AND stage_id=NEW.stage_id
     ) THEN
    RAISE EXCEPTION 'Hosted publication cleanup requires the exact unsealed terminal stage'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION content.guard_hosted_publication_staging_cleanup_progress()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stage_status text; stage_epoch bigint; stage_sealed_at timestamptz; authority text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Hosted publication cleanup progress is durable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - 'phase' - 'candidate_frontier' - 'input_frontier' - 'target_thread_id'
        - 'target_post_id' - 'target_revision_id' - 'target_sha256' - 'deleted_row_count'
        - 'cleanup_active' - 'completed_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'phase' - 'candidate_frontier' - 'input_frontier' - 'target_thread_id'
        - 'target_post_id' - 'target_revision_id' - 'target_sha256' - 'deleted_row_count'
        - 'cleanup_active' - 'completed_at') THEN
    RAISE EXCEPTION 'Hosted publication cleanup binding is immutable' USING ERRCODE = '23514';
  END IF;
  authority := current_setting('content.hosted_publication_staging_cleanup', true);
  IF authority IS DISTINCT FROM format('%s:%s:%s:%s',OLD.route,OLD.catalogue_id,OLD.stage_id,OLD.owner_epoch)
     OR (OLD.cleanup_active AND NEW.cleanup_active)
     OR (NOT OLD.cleanup_active AND NOT NEW.cleanup_active)
     OR (NOT OLD.cleanup_active AND (
       NEW.phase IS DISTINCT FROM OLD.phase
       OR NEW.candidate_frontier IS DISTINCT FROM OLD.candidate_frontier
       OR NEW.input_frontier IS DISTINCT FROM OLD.input_frontier
       OR NEW.target_thread_id IS DISTINCT FROM OLD.target_thread_id
       OR NEW.target_post_id IS DISTINCT FROM OLD.target_post_id
       OR NEW.target_revision_id IS DISTINCT FROM OLD.target_revision_id
       OR NEW.target_sha256 IS DISTINCT FROM OLD.target_sha256
       OR NEW.deleted_row_count IS DISTINCT FROM OLD.deleted_row_count
       OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     ))
     OR (OLD.cleanup_active AND (
       CASE NEW.phase WHEN 'candidate' THEN 0 WHEN 'input' THEN 1 WHEN 'target' THEN 2 ELSE 3 END
         < CASE OLD.phase WHEN 'candidate' THEN 0 WHEN 'input' THEN 1 WHEN 'target' THEN 2 ELSE 3 END
       OR NEW.candidate_frontier < OLD.candidate_frontier
       OR NEW.input_frontier < OLD.input_frontier
       OR NEW.deleted_row_count < OLD.deleted_row_count
       OR (OLD.target_thread_id IS NOT NULL AND NEW.target_thread_id IS NULL)
       OR (OLD.target_thread_id IS NOT NULL AND NEW.target_thread_id IS NOT NULL AND
         ROW(NEW.target_thread_id,NEW.target_post_id,NEW.target_revision_id,NEW.target_sha256) <
         ROW(OLD.target_thread_id,OLD.target_post_id,OLD.target_revision_id,OLD.target_sha256))
     )) THEN
    RAISE EXCEPTION 'Hosted publication cleanup progress requires its exact active step'
      USING ERRCODE = '23514';
  END IF;
  SELECT status,owner_epoch,sealed_at INTO stage_status,stage_epoch,stage_sealed_at
  FROM content.hosted_publication_staging
  WHERE route=OLD.route AND catalogue_id=OLD.catalogue_id AND stage_id=OLD.stage_id
  FOR UPDATE;
  IF NOT FOUND OR stage_status IS DISTINCT FROM OLD.terminal_status
     OR stage_epoch IS DISTINCT FROM OLD.owner_epoch
     OR stage_status NOT IN ('cancelled','expired','failed')
     OR stage_sealed_at IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM content.hosted_publication_staging_seal
       WHERE route=OLD.route AND catalogue_id=OLD.catalogue_id AND stage_id=OLD.stage_id
     ) THEN
    RAISE EXCEPTION 'Hosted publication cleanup lost its terminal stage authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION content.guard_hosted_publication_staging_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority text;
BEGIN
  authority := current_setting('content.hosted_publication_staging_cleanup', true);
  IF TG_OP = 'DELETE'
     AND TG_TABLE_SCHEMA = 'content'
     AND TG_TABLE_NAME IN ('hosted_publication_staging_input',
                           'hosted_publication_staging_candidate',
                           'hosted_publication_staging_target')
     AND EXISTS (
       SELECT 1
       FROM content.hosted_publication_staging_cleanup cleanup
       JOIN content.hosted_publication_staging stage
         USING (route,catalogue_id,stage_id)
       WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
         AND cleanup.stage_id=OLD.stage_id
         AND cleanup.owner_epoch=stage.owner_epoch
         AND cleanup.terminal_status=stage.status
         AND cleanup.cleanup_active
         AND stage.status IN ('cancelled','expired','failed')
         AND stage.sealed_at IS NULL
         AND authority = format('%s:%s:%s:%s',cleanup.route,cleanup.catalogue_id,
                                cleanup.stage_id,cleanup.owner_epoch)
         AND NOT EXISTS (
           SELECT 1 FROM content.hosted_publication_staging_seal seal
           WHERE seal.route=cleanup.route AND seal.catalogue_id=cleanup.catalogue_id
             AND seal.stage_id=cleanup.stage_id
         )
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Hosted publication staging facts are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER hosted_publication_staging_cleanup_insert_guard
  BEFORE INSERT ON content.hosted_publication_staging_cleanup
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_publication_staging_cleanup_insert();
CREATE TRIGGER hosted_publication_staging_cleanup_progress_guard
  BEFORE UPDATE OR DELETE ON content.hosted_publication_staging_cleanup
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_publication_staging_cleanup_progress();
CREATE TRIGGER hosted_publication_staging_cleanup_step_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_publication_staging_cleanup_step
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_publication_staging_fact();

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_publication_staging_cleanup LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back hosted publication cleanup after its frontier is recorded'
      USING ERRCODE = '23514';
  END IF;
END;
$$;
DROP TRIGGER hosted_publication_staging_cleanup_step_immutable
  ON content.hosted_publication_staging_cleanup_step;
DROP TRIGGER hosted_publication_staging_cleanup_progress_guard
  ON content.hosted_publication_staging_cleanup;
DROP TRIGGER hosted_publication_staging_cleanup_insert_guard
  ON content.hosted_publication_staging_cleanup;
DROP FUNCTION content.guard_hosted_publication_staging_cleanup_progress();
DROP FUNCTION content.guard_hosted_publication_staging_cleanup_insert();
CREATE OR REPLACE FUNCTION content.guard_hosted_publication_staging_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hosted publication staging facts are immutable' USING ERRCODE = '23514';
END;
$$;
DROP TABLE content.hosted_publication_staging_cleanup_step;
DROP TABLE content.hosted_publication_staging_cleanup;
