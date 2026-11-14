-- migrate:up
-- Preserve historical expired claims; cancelled sources retain their actual terminal outcome.
ALTER TABLE content.hosted_version_candidate_cleanup
  DROP CONSTRAINT hosted_version_candidate_cleanup_terminal_status_check,
  ADD CONSTRAINT hosted_version_candidate_cleanup_terminal_status_check
    CHECK (terminal_status IN ('expired','cancelled'));

-- Retain the exact seal, checkpoint, generation lock and descriptor fences for both terminal states.
CREATE OR REPLACE FUNCTION content.guard_hosted_candidate_checkpoint_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_generation uuid;
  claimed boolean;
  authority text;
BEGIN
  IF TG_TABLE_NAME='hosted_version_release_candidate' AND TG_OP='UPDATE' THEN
    IF OLD.generation_id IS DISTINCT FROM NEW.generation_id THEN
      IF OLD.generation_id IS NULL OR NEW.generation_id IS NOT NULL
         OR OLD.status NOT IN ('building','sealed') OR NEW.status<>'retiring'
         OR NEW.mode IS DISTINCT FROM OLD.mode
         OR OLD.mode NOT IN ('whole','selection')
         OR NEW.owner_epoch IS DISTINCT FROM OLD.owner_epoch
         OR NEW.route IS DISTINCT FROM OLD.route OR NEW.catalogue_id IS DISTINCT FROM OLD.catalogue_id
         OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
         OR (to_jsonb(NEW)-'generation_id'-'status'-'updated_at')
              IS DISTINCT FROM (to_jsonb(OLD)-'generation_id'-'status'-'updated_at') THEN
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
        JOIN content.hosted_publication_staging_seal seal
          USING (route,catalogue_id,stage_id)
        WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
          AND cleanup.stage_id=OLD.stage_id AND cleanup.generation_id=OLD.generation_id
          AND cleanup.owner_epoch=OLD.owner_epoch AND cleanup.terminal_status IN ('expired','cancelled')
          AND cleanup.phase='nodes' AND NOT cleanup.cleanup_active AND cleanup.completed_at IS NULL
          AND stage.initiator_account_id=OLD.initiator_account_id
          AND stage.owner_epoch=OLD.owner_epoch AND stage.mode=OLD.mode
          AND stage.status=cleanup.terminal_status AND stage.sealed_at IS NOT NULL
          AND (stage.status='expired' OR stage.expires_at<=clock_timestamp())
          AND stage.source_revision_id=stage.expected_head_revision_id
          AND stage.source_revision_id=OLD.source_revision_id
          AND stage.expected_head_revision_id=OLD.expected_head_revision_id
          AND stage.expected_publication_id IS NOT DISTINCT FROM OLD.expected_publication_id
          AND stage.input_version=seal.input_version AND OLD.input_version=seal.input_version
          AND stage.candidate_count=seal.candidate_count
          AND OLD.source_candidate_count=seal.candidate_count
          AND stage.sealed_at=seal.sealed_at AND OLD.source_sealed_at=seal.sealed_at
          AND (stage.mode='whole' OR stage.input_frozen_version=stage.input_version)
      ) THEN
        RAISE EXCEPTION 'Hosted release candidate retirement requires its terminal source claim' USING ERRCODE='23514';
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
          AND cleanup.terminal_status IN ('expired','cancelled') AND cleanup.phase='generation'
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
         JOIN content.hosted_publication_staging_seal seal
           USING (route,catalogue_id,stage_id)
         JOIN content.hosted_version_release_candidate candidate
           USING (route,catalogue_id,stage_id)
         WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
           AND cleanup.generation_id=OLD.generation_id AND cleanup.terminal_status IN ('expired','cancelled')
           AND cleanup.phase='nodes' AND NOT cleanup.cleanup_active AND cleanup.completed_at IS NULL
           AND cleanup.owner_epoch=stage.owner_epoch AND cleanup.owner_epoch=candidate.owner_epoch
           AND stage.initiator_account_id=candidate.initiator_account_id
           AND stage.mode=candidate.mode AND stage.mode IN ('whole','selection')
           AND stage.status=cleanup.terminal_status AND stage.sealed_at IS NOT NULL
           AND (stage.status='expired' OR stage.expires_at<=clock_timestamp())
           AND stage.source_revision_id=stage.expected_head_revision_id
           AND stage.source_revision_id=candidate.source_revision_id
           AND stage.expected_head_revision_id=candidate.expected_head_revision_id
           AND stage.expected_publication_id IS NOT DISTINCT FROM candidate.expected_publication_id
           AND stage.input_version=seal.input_version AND candidate.input_version=seal.input_version
           AND stage.candidate_count=seal.candidate_count
           AND candidate.source_candidate_count=seal.candidate_count
           AND stage.sealed_at=seal.sealed_at AND candidate.source_sealed_at=seal.sealed_at
           AND (stage.mode='whole' OR stage.input_frozen_version=stage.input_version)
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

-- migrate:down
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM content.hosted_version_candidate_cleanup WHERE terminal_status='cancelled' LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot roll back cancelled hosted candidate cleanup evidence' USING ERRCODE='23514';
  END IF;
END;
$$;

ALTER TABLE content.hosted_version_candidate_cleanup
  DROP CONSTRAINT hosted_version_candidate_cleanup_terminal_status_check,
  ADD CONSTRAINT hosted_version_candidate_cleanup_terminal_status_check CHECK (terminal_status='expired');

CREATE OR REPLACE FUNCTION content.guard_hosted_candidate_checkpoint_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_generation uuid;
  claimed boolean;
  authority text;
BEGIN
  IF TG_TABLE_NAME='hosted_version_release_candidate' AND TG_OP='UPDATE' THEN
    IF OLD.generation_id IS DISTINCT FROM NEW.generation_id THEN
      IF OLD.generation_id IS NULL OR NEW.generation_id IS NOT NULL
         OR OLD.status NOT IN ('building','sealed') OR NEW.status<>'retiring'
         OR NEW.mode IS DISTINCT FROM OLD.mode
         OR OLD.mode NOT IN ('whole','selection')
         OR NEW.owner_epoch IS DISTINCT FROM OLD.owner_epoch
         OR NEW.route IS DISTINCT FROM OLD.route OR NEW.catalogue_id IS DISTINCT FROM OLD.catalogue_id
         OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
         OR (to_jsonb(NEW)-'generation_id'-'status'-'updated_at')
              IS DISTINCT FROM (to_jsonb(OLD)-'generation_id'-'status'-'updated_at') THEN
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
        JOIN content.hosted_publication_staging_seal seal
          USING (route,catalogue_id,stage_id)
        WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
          AND cleanup.stage_id=OLD.stage_id AND cleanup.generation_id=OLD.generation_id
          AND cleanup.owner_epoch=OLD.owner_epoch AND cleanup.terminal_status='expired'
          AND cleanup.phase='nodes' AND NOT cleanup.cleanup_active AND cleanup.completed_at IS NULL
          AND stage.initiator_account_id=OLD.initiator_account_id
          AND stage.owner_epoch=OLD.owner_epoch AND stage.mode=OLD.mode
          AND stage.status='expired' AND stage.sealed_at IS NOT NULL
          AND stage.source_revision_id=stage.expected_head_revision_id
          AND stage.source_revision_id=OLD.source_revision_id
          AND stage.expected_head_revision_id=OLD.expected_head_revision_id
          AND stage.expected_publication_id IS NOT DISTINCT FROM OLD.expected_publication_id
          AND stage.input_version=seal.input_version AND OLD.input_version=seal.input_version
          AND stage.candidate_count=seal.candidate_count
          AND OLD.source_candidate_count=seal.candidate_count
          AND stage.sealed_at=seal.sealed_at AND OLD.source_sealed_at=seal.sealed_at
          AND (stage.mode='whole' OR stage.input_frozen_version=stage.input_version)
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
         JOIN content.hosted_publication_staging_seal seal
           USING (route,catalogue_id,stage_id)
         JOIN content.hosted_version_release_candidate candidate
           USING (route,catalogue_id,stage_id)
         WHERE cleanup.route=OLD.route AND cleanup.catalogue_id=OLD.catalogue_id
           AND cleanup.generation_id=OLD.generation_id AND cleanup.terminal_status='expired'
           AND cleanup.phase='nodes' AND NOT cleanup.cleanup_active AND cleanup.completed_at IS NULL
           AND cleanup.owner_epoch=stage.owner_epoch AND cleanup.owner_epoch=candidate.owner_epoch
           AND stage.initiator_account_id=candidate.initiator_account_id
           AND stage.mode=candidate.mode AND stage.mode IN ('whole','selection')
           AND stage.status='expired' AND stage.sealed_at IS NOT NULL
           AND stage.source_revision_id=stage.expected_head_revision_id
           AND stage.source_revision_id=candidate.source_revision_id
           AND stage.expected_head_revision_id=candidate.expected_head_revision_id
           AND stage.expected_publication_id IS NOT DISTINCT FROM candidate.expected_publication_id
           AND stage.input_version=seal.input_version AND candidate.input_version=seal.input_version
           AND stage.candidate_count=seal.candidate_count
           AND candidate.source_candidate_count=seal.candidate_count
           AND stage.sealed_at=seal.sealed_at AND candidate.source_sealed_at=seal.sealed_at
           AND (stage.mode='whole' OR stage.input_frozen_version=stage.input_version)
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

