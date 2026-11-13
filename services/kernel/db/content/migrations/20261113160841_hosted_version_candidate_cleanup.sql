-- migrate:up
-- Retire only expired whole-Book candidates after their exact generation has been fenced and proven unpinned.
ALTER TABLE content.hosted_tree_generation
  ADD COLUMN retirement_claimed boolean NOT NULL DEFAULT false;

ALTER TABLE content.hosted_version_release_candidate
  ALTER COLUMN generation_id DROP NOT NULL,
  DROP CONSTRAINT hosted_version_release_candidate_check1,
  DROP CONSTRAINT hosted_version_release_candidate_status_check,
  ADD CONSTRAINT hosted_version_release_candidate_check1 CHECK (
    route = get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)
    AND route = get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)
    AND (generation_id IS NULL OR route = get_byte(uuid_send(generation_id),10)*256+get_byte(uuid_send(generation_id),11))
    AND route = get_byte(uuid_send(initiator_account_id),10)*256+get_byte(uuid_send(initiator_account_id),11)
    AND route = get_byte(uuid_send(source_revision_id),10)*256+get_byte(uuid_send(source_revision_id),11)
    AND route = get_byte(uuid_send(expected_head_revision_id),10)*256+get_byte(uuid_send(expected_head_revision_id),11)
    AND (expected_publication_id IS NULL OR
      route = get_byte(uuid_send(expected_publication_id),10)*256+get_byte(uuid_send(expected_publication_id),11))
  ),
  ADD CONSTRAINT hosted_version_release_candidate_status_check CHECK (
    (status='building' AND sealed_at IS NULL AND generation_id IS NOT NULL)
    OR (status='sealed' AND sealed_at IS NOT NULL AND coverage_complete AND generation_id IS NOT NULL)
    OR (status='retiring' AND generation_id IS NULL
      AND (sealed_at IS NULL OR (sealed_at IS NOT NULL AND coverage_complete)))
    OR (status='reclaimed' AND generation_id IS NULL
      AND (sealed_at IS NULL OR (sealed_at IS NOT NULL AND coverage_complete)))
  );

-- This small row is the durable, exact identity of the terminal cleanup claim.
-- It intentionally has no generation FK so the generation row can be retired after its version rows.
CREATE TABLE content.hosted_version_candidate_cleanup (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  owner_epoch bigint NOT NULL CHECK (owner_epoch >= 0),
  terminal_status text NOT NULL DEFAULT 'expired' CHECK (terminal_status = 'expired'),
  phase text NOT NULL DEFAULT 'nodes'
    CHECK (phase IN ('nodes','occurrences','sibling_roots','snapshots','generation','done')),
  cursor jsonb NOT NULL DEFAULT 'null'::jsonb CHECK (jsonb_typeof(cursor) IN ('object','null')),
  deleted_row_count bigint NOT NULL DEFAULT 0 CHECK (deleted_row_count >= 0),
  cleanup_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  completed_at timestamptz CHECK (completed_at IS NULL OR isfinite(completed_at)),
  PRIMARY KEY (route,catalogue_id,stage_id),
  UNIQUE (route,catalogue_id,generation_id),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_publication_staging(route,catalogue_id,stage_id),
  CHECK (route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)),
  CHECK (route=get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)),
  CHECK (route=get_byte(uuid_send(generation_id),10)*256+get_byte(uuid_send(generation_id),11)),
  CHECK ((phase='done')=(completed_at IS NOT NULL)),
  CHECK (NOT cleanup_active OR completed_at IS NULL)
);

CREATE TABLE content.hosted_version_candidate_cleanup_step (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  step_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('nodes','occurrences','sibling_roots','snapshots','generation','done')),
  cursor jsonb NOT NULL CHECK (jsonb_typeof(cursor) IN ('object','null')),
  deleted_row_count bigint NOT NULL CHECK (deleted_row_count >= 0),
  deleted_rows integer NOT NULL CHECK (deleted_rows BETWEEN 0 AND 100),
  completed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (route,catalogue_id,stage_id,step_id),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_version_candidate_cleanup(route,catalogue_id,stage_id),
  CHECK (route=get_byte(uuid_send(step_id),10)*256+get_byte(uuid_send(step_id),11)),
  CHECK ((phase='done')=completed)
);

CREATE INDEX hosted_publication_staging_active_ordered_generation
  ON content.hosted_publication_staging(route,catalogue_id,source_ordered_generation_id)
  WHERE source_kind='ordered' AND status NOT IN ('cancelled','expired','failed');

-- Candidate descriptor insertion takes the generation lock. Retirement takes the same lock before
-- checking pins, so either the descriptor commits first and is retained, or retirement fences it out.
CREATE FUNCTION content.guard_hosted_candidate_revision_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claimed boolean;
BEGIN
  IF NEW.generation_kind <> 'candidate' THEN
    RETURN NEW;
  END IF;
  SELECT generation.retirement_claimed INTO claimed
  FROM content.hosted_tree_generation generation
  WHERE generation.route=NEW.route AND generation.catalogue_id=NEW.catalogue_id
    AND generation.generation_id=NEW.generation_id
  FOR UPDATE;
  IF claimed THEN
    RAISE EXCEPTION 'Hosted candidate generation is being retired' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hosted_version_revision_candidate_cleanup_fence
  BEFORE INSERT ON content.hosted_version_revision
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_candidate_revision_claim();

CREATE FUNCTION content.guard_hosted_candidate_checkpoint_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_generation uuid;
  claimed boolean;
  authority text;
BEGIN
  IF TG_TABLE_NAME='hosted_version_release_candidate' AND TG_OP='UPDATE' THEN
    IF OLD.generation_id IS DISTINCT FROM NEW.generation_id THEN
      IF OLD.generation_id IS NULL OR NEW.generation_id IS NOT NULL
         OR OLD.status NOT IN ('building','sealed') OR NEW.status<>'retiring'
         OR NEW.mode<>'whole' OR NEW.owner_epoch IS DISTINCT FROM OLD.owner_epoch
         OR NEW.route IS DISTINCT FROM OLD.route OR NEW.catalogue_id IS DISTINCT FROM OLD.catalogue_id
         OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
        RAISE EXCEPTION 'Hosted release candidate generation identity is immutable' USING ERRCODE='23514';
      END IF;
      SELECT generation.retirement_claimed INTO claimed
      FROM content.hosted_tree_generation generation
      WHERE generation.route=OLD.route AND generation.catalogue_id=OLD.catalogue_id
        AND generation.generation_id=OLD.generation_id
      FOR UPDATE;
      IF NOT FOUND OR claimed IS DISTINCT FROM false OR NOT EXISTS (
        SELECT 1
        FROM content.hosted_version_candidate_cleanup cleanup
        JOIN content.hosted_publication_staging stage
          USING (route,catalogue_id,stage_id)
        WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
          AND cleanup.stage_id=OLD.stage_id AND cleanup.generation_id=OLD.generation_id
          AND cleanup.owner_epoch=OLD.owner_epoch AND cleanup.terminal_status='expired'
          AND cleanup.phase='nodes' AND NOT cleanup.cleanup_active AND cleanup.completed_at IS NULL
          AND stage.owner_epoch=OLD.owner_epoch AND stage.mode='whole'
          AND stage.status='expired' AND stage.sealed_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM content.hosted_publication_staging_seal seal
            WHERE seal.route=stage.route AND seal.catalogue_id=stage.catalogue_id
              AND seal.stage_id=stage.stage_id
          )
      ) THEN
        RAISE EXCEPTION 'Hosted release candidate retirement requires its expired source claim' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.generation_id IS NULL THEN
      authority := current_setting('content.hosted_version_candidate_cleanup',true);
      IF OLD.status='retiring' AND NEW.status='reclaimed'
         AND (to_jsonb(NEW)-'status'-'updated_at') IS NOT DISTINCT FROM
             (to_jsonb(OLD)-'status'-'updated_at') THEN
        SELECT generation_id INTO target_generation
        FROM content.hosted_version_candidate_cleanup cleanup
        WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
          AND cleanup.stage_id=OLD.stage_id AND cleanup.owner_epoch=OLD.owner_epoch
          AND cleanup.terminal_status='expired' AND cleanup.phase='generation'
          AND cleanup.cleanup_active AND cleanup.completed_at IS NULL
          AND authority=format('%s:%s:%s:%s',cleanup.route,cleanup.catalogue_id,
                               cleanup.stage_id,cleanup.generation_id);
        IF target_generation IS NOT NULL THEN
          SELECT generation.retirement_claimed INTO claimed
          FROM content.hosted_tree_generation generation
          WHERE generation.route=OLD.route AND generation.catalogue_id=OLD.catalogue_id
            AND generation.generation_id=target_generation
          FOR UPDATE;
          IF FOUND AND claimed THEN
            RETURN NEW;
          END IF;
        END IF;
      END IF;
      RAISE EXCEPTION 'Retired hosted release candidate checkpoint is immutable' USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.generation_id IS NULL THEN
    RAISE EXCEPTION 'Hosted checkpoint requires a generation identity' USING ERRCODE='23514';
  END IF;
  SELECT generation.retirement_claimed INTO claimed
  FROM content.hosted_tree_generation generation
  WHERE generation.route=NEW.route AND generation.catalogue_id=NEW.catalogue_id
    AND generation.generation_id=NEW.generation_id
  FOR UPDATE;
  IF claimed THEN
    RAISE EXCEPTION 'Hosted candidate generation cannot receive another checkpoint' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hosted_version_draft_activation_candidate_cleanup_fence
  BEFORE INSERT OR UPDATE OF generation_id ON content.hosted_version_draft_activation
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_candidate_checkpoint_claim();
CREATE TRIGGER hosted_version_public_baseline_candidate_cleanup_fence
  BEFORE INSERT OR UPDATE OF generation_id ON content.hosted_version_public_baseline
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_candidate_checkpoint_claim();
CREATE TRIGGER hosted_version_release_candidate_cleanup_fence
  BEFORE INSERT OR UPDATE ON content.hosted_version_release_candidate
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_candidate_checkpoint_claim();

CREATE OR REPLACE FUNCTION content.advance_hosted_version_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.route IS DISTINCT FROM OLD.route OR
     NEW.catalogue_id IS DISTINCT FROM OLD.catalogue_id OR
     NEW.generation_id IS DISTINCT FROM OLD.generation_id OR
     NEW.generation_kind IS DISTINCT FROM OLD.generation_kind OR
     NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Hosted version identity is immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.retirement_claimed IS DISTINCT FROM OLD.retirement_claimed THEN
    IF OLD.retirement_claimed OR NOT NEW.retirement_claimed OR NEW.head_sequence<>OLD.head_sequence OR
       NOT EXISTS (
         SELECT 1 FROM content.hosted_version_candidate_cleanup cleanup
         JOIN content.hosted_publication_staging stage
           USING (route,catalogue_id,stage_id)
         JOIN content.hosted_version_release_candidate candidate
           USING (route,catalogue_id,stage_id)
         WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
           AND cleanup.generation_id=OLD.generation_id AND cleanup.terminal_status='expired'
           AND cleanup.phase='nodes' AND NOT cleanup.cleanup_active AND cleanup.completed_at IS NULL
           AND stage.owner_epoch=cleanup.owner_epoch AND stage.mode='whole'
           AND stage.status='expired' AND stage.sealed_at IS NOT NULL
           AND candidate.owner_epoch=cleanup.owner_epoch AND candidate.mode='whole'
           AND candidate.status='retiring' AND candidate.generation_id IS NULL
       ) THEN
      RAISE EXCEPTION 'Hosted version retirement claim is invalid' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.retirement_claimed OR NEW.head_sequence<>OLD.head_sequence+1 THEN
    RAISE EXCEPTION 'Hosted version head cannot advance after retirement or skip a sequence'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Keep the existing append-only guard. A DELETE is admitted only for this exact claimed generation
-- while its native cleanup transaction holds the claim active; UPDATE remains forbidden.
CREATE OR REPLACE FUNCTION content.guard_hosted_version_rows() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  authority text;
BEGIN
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
  RAISE EXCEPTION 'Hosted version rows are append only' USING ERRCODE = '23514';
END;
$$;

CREATE FUNCTION content.guard_hosted_candidate_generation_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  authority text;
BEGIN
  authority := current_setting('content.hosted_version_candidate_cleanup',true);
  IF OLD.retirement_claimed AND EXISTS (
    SELECT 1 FROM content.hosted_version_candidate_cleanup cleanup
    WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
      AND cleanup.generation_id=OLD.generation_id AND cleanup.cleanup_active
      AND cleanup.completed_at IS NULL
      AND authority=cleanup.route::text||':'||cleanup.catalogue_id::text||':'||cleanup.stage_id::text||':'||cleanup.generation_id::text
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Hosted version generation deletion requires its exact cleanup claim' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER hosted_tree_generation_candidate_cleanup_delete
  BEFORE DELETE ON content.hosted_tree_generation
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_candidate_generation_delete();

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_version_candidate_cleanup LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back hosted candidate cleanup evidence' USING ERRCODE='23514';
  END IF;
END;
$$;

DROP TRIGGER hosted_tree_generation_candidate_cleanup_delete ON content.hosted_tree_generation;
DROP FUNCTION content.guard_hosted_candidate_generation_delete();
DROP TRIGGER hosted_version_revision_candidate_cleanup_fence ON content.hosted_version_revision;
DROP FUNCTION content.guard_hosted_candidate_revision_claim();
DROP TRIGGER hosted_version_public_baseline_candidate_cleanup_fence ON content.hosted_version_public_baseline;
DROP TRIGGER hosted_version_draft_activation_candidate_cleanup_fence ON content.hosted_version_draft_activation;
DROP TRIGGER hosted_version_release_candidate_cleanup_fence ON content.hosted_version_release_candidate;
DROP FUNCTION content.guard_hosted_candidate_checkpoint_claim();

CREATE OR REPLACE FUNCTION content.guard_hosted_version_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hosted version rows are append only' USING ERRCODE = '23514';
END;
$$;
CREATE OR REPLACE FUNCTION content.advance_hosted_version_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.route IS DISTINCT FROM OLD.route OR
     NEW.catalogue_id IS DISTINCT FROM OLD.catalogue_id OR
     NEW.generation_id IS DISTINCT FROM OLD.generation_id OR
     NEW.generation_kind IS DISTINCT FROM OLD.generation_kind OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR
     NEW.head_sequence <> OLD.head_sequence + 1 THEN
    RAISE EXCEPTION 'Hosted version head must advance exactly once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TABLE content.hosted_version_candidate_cleanup_step;
DROP TABLE content.hosted_version_candidate_cleanup;
DROP INDEX content.hosted_publication_staging_active_ordered_generation;
ALTER TABLE content.hosted_version_release_candidate
  DROP CONSTRAINT hosted_version_release_candidate_check1,
  DROP CONSTRAINT hosted_version_release_candidate_status_check,
  ALTER COLUMN generation_id SET NOT NULL,
  ADD CONSTRAINT hosted_version_release_candidate_check1 CHECK (
    route = get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)
    AND route = get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)
    AND route = get_byte(uuid_send(generation_id),10)*256+get_byte(uuid_send(generation_id),11)
    AND route = get_byte(uuid_send(initiator_account_id),10)*256+get_byte(uuid_send(initiator_account_id),11)
    AND route = get_byte(uuid_send(source_revision_id),10)*256+get_byte(uuid_send(source_revision_id),11)
    AND route = get_byte(uuid_send(expected_head_revision_id),10)*256+get_byte(uuid_send(expected_head_revision_id),11)
    AND (expected_publication_id IS NULL OR
      route = get_byte(uuid_send(expected_publication_id),10)*256+get_byte(uuid_send(expected_publication_id),11))
  ),
  ADD CONSTRAINT hosted_version_release_candidate_status_check CHECK (
    (status='building' AND sealed_at IS NULL) OR
    (status='sealed' AND sealed_at IS NOT NULL AND coverage_complete)
  );
ALTER TABLE content.hosted_tree_generation DROP COLUMN retirement_claimed;
