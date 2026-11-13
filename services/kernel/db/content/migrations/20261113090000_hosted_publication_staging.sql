-- migrate:up
-- Private, restartable preparation for exact whole-Book and explicit selection releases.
-- These rows never move the installed publication pointer and carry no activation proof.
CREATE TABLE content.hosted_publication_staging (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  initiator_account_id uuid NOT NULL,
  owner_epoch bigint NOT NULL CHECK (owner_epoch >= 0),
  source_revision_id uuid NOT NULL,
  expected_head_revision_id uuid NOT NULL,
  expected_publication_id uuid,
  mode text NOT NULL CHECK (mode IN ('whole', 'selection')),
  source_has_descriptor boolean NOT NULL,
  source_descriptor_revision_id uuid,
  source_base_revision_id uuid NOT NULL,
  source_base_placement_count bigint,
  source_base_root_count bigint,
  source_high_water bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('collecting', 'building', 'closing', 'ready', 'sealed', 'cancelled', 'expired', 'failed')),
  input_version bigint NOT NULL DEFAULT 0 CHECK (input_version >= 0),
  input_count bigint NOT NULL DEFAULT 0 CHECK (input_count >= 0),
  input_frozen_version bigint,
  input_frontier bigint NOT NULL DEFAULT -1 CHECK (input_frontier >= -1),
  settled_input_count bigint NOT NULL DEFAULT 0 CHECK (settled_input_count >= 0),
  candidate_count bigint NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  duplicate_input_count bigint NOT NULL DEFAULT 0 CHECK (duplicate_input_count >= 0),
  unknown_input_count bigint NOT NULL DEFAULT 0 CHECK (unknown_input_count >= 0),
  target_observation_count bigint NOT NULL DEFAULT 0 CHECK (target_observation_count >= 0),
  source_frontier bigint NOT NULL DEFAULT -1 CHECK (source_frontier >= -1),
  source_exhausted boolean NOT NULL DEFAULT false,
  closure_frontier bigint NOT NULL DEFAULT -1 CHECK (closure_frontier >= -1),
  closure_checked_count bigint NOT NULL DEFAULT 0 CHECK (closure_checked_count >= 0),
  closure_missing_count bigint NOT NULL DEFAULT 0 CHECK (closure_missing_count >= 0),
  failure text,
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  sealed_at timestamptz CHECK (sealed_at IS NULL OR isfinite(sealed_at)),
  PRIMARY KEY (route, catalogue_id, stage_id),
  FOREIGN KEY (route, catalogue_id) REFERENCES content.hosted_catalogue(route, catalogue_id),
  FOREIGN KEY (route, catalogue_id, source_revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id, source_descriptor_revision_id)
    REFERENCES content.hosted_append_descriptor(route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id, expected_head_revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id, expected_publication_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id, source_base_revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  CHECK (route = get_byte(uuid_send(catalogue_id), 10) * 256 + get_byte(uuid_send(catalogue_id), 11)),
  CHECK (route = get_byte(uuid_send(stage_id), 10) * 256 + get_byte(uuid_send(stage_id), 11)),
  CHECK (expected_head_revision_id = source_revision_id),
  CHECK (expected_publication_id IS NULL OR route = get_byte(uuid_send(expected_publication_id), 10) * 256 + get_byte(uuid_send(expected_publication_id), 11)),
  CHECK (
    (source_has_descriptor AND source_descriptor_revision_id=source_revision_id
      AND source_base_placement_count BETWEEN 0 AND 9007199254740991
      AND source_base_root_count BETWEEN 0 AND source_base_placement_count
      AND source_high_water BETWEEN -1 AND 9007199254740990)
    OR
    (NOT source_has_descriptor AND source_descriptor_revision_id IS NULL
      AND source_base_revision_id = source_revision_id
      AND source_base_placement_count IS NULL AND source_base_root_count IS NULL AND source_high_water = -1)
  ),
  CHECK (input_frozen_version IS NULL OR input_frozen_version <= input_version),
  CHECK (settled_input_count <= input_count),
  CHECK (duplicate_input_count + unknown_input_count <= settled_input_count),
  CHECK ((mode = 'whole' AND input_count = 0 AND input_version = 0 AND input_frozen_version IS NULL)
      OR mode = 'selection')
);

CREATE INDEX hosted_publication_staging_expiry
  ON content.hosted_publication_staging(route, expires_at, catalogue_id, stage_id);

CREATE TABLE content.hosted_publication_staging_batch (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  input_version bigint NOT NULL CHECK (input_version > 0),
  first_input_position bigint NOT NULL CHECK (first_input_position >= 0),
  item_count integer NOT NULL CHECK (item_count BETWEEN 1 AND 512),
  payload_sha256 bytea NOT NULL CHECK (octet_length(payload_sha256) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (route, catalogue_id, stage_id, batch_id),
  UNIQUE (route, catalogue_id, stage_id, input_version),
  FOREIGN KEY (route, catalogue_id, stage_id)
    REFERENCES content.hosted_publication_staging(route, catalogue_id, stage_id),
  CHECK (route = get_byte(uuid_send(batch_id), 10) * 256 + get_byte(uuid_send(batch_id), 11))
);

CREATE TABLE content.hosted_publication_staging_input (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  input_position bigint NOT NULL CHECK (input_position >= 0),
  occurrence_id uuid NOT NULL,
  settlement text NOT NULL DEFAULT 'pending' CHECK (settlement IN ('pending', 'selected', 'duplicate', 'unknown')),
  source_order bigint,
  PRIMARY KEY (route, catalogue_id, stage_id, input_position),
  FOREIGN KEY (route, catalogue_id, stage_id)
    REFERENCES content.hosted_publication_staging(route, catalogue_id, stage_id),
  CHECK (route = get_byte(uuid_send(occurrence_id), 10) * 256 + get_byte(uuid_send(occurrence_id), 11)),
  CHECK ((settlement = 'selected') = (source_order IS NOT NULL))
);
CREATE INDEX hosted_publication_staging_input_pending
  ON content.hosted_publication_staging_input(route, catalogue_id, stage_id, input_position)
  WHERE settlement = 'pending';
CREATE INDEX hosted_publication_staging_input_identity
  ON content.hosted_publication_staging_input(route, catalogue_id, stage_id, occurrence_id, input_position);

-- A successful exact native Post metadata check is recorded separately from
-- selection membership. It is neither current public eligibility nor activation proof.
CREATE TABLE content.hosted_publication_staging_target (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  post_id uuid NOT NULL,
  target_revision_id uuid NOT NULL,
  body_sha256 bytea NOT NULL CHECK (octet_length(body_sha256) = 32),
  author_account_id uuid NOT NULL,
  licence text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(observed_at)),
  PRIMARY KEY (route, catalogue_id, stage_id, thread_id, post_id, target_revision_id, body_sha256),
  FOREIGN KEY (route, catalogue_id, stage_id)
    REFERENCES content.hosted_publication_staging(route, catalogue_id, stage_id),
  CHECK (thread_id IS NOT NULL AND post_id IS NOT NULL AND target_revision_id IS NOT NULL)
);

CREATE TABLE content.hosted_publication_staging_candidate (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  source_order bigint NOT NULL CHECK (source_order >= 0),
  occurrence_id uuid NOT NULL,
  parent_id uuid,
  position bigint NOT NULL CHECK (position >= 0),
  source_segment text NOT NULL CHECK (source_segment IN ('snapshot', 'base', 'append')),
  kind text NOT NULL CHECK (kind IN ('part', 'chapter')),
  thread_id uuid,
  post_id uuid,
  target_revision_id uuid,
  body_sha256 bytea,
  PRIMARY KEY (route, catalogue_id, stage_id, source_order),
  UNIQUE (route, catalogue_id, stage_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, stage_id)
    REFERENCES content.hosted_publication_staging(route, catalogue_id, stage_id),
  FOREIGN KEY (route, catalogue_id, occurrence_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, stage_id, thread_id, post_id, target_revision_id, body_sha256)
    REFERENCES content.hosted_publication_staging_target
      (route, catalogue_id, stage_id, thread_id, post_id, target_revision_id, body_sha256),
  CHECK (route = get_byte(uuid_send(occurrence_id), 10) * 256 + get_byte(uuid_send(occurrence_id), 11)),
  CHECK (parent_id IS NULL OR route = get_byte(uuid_send(parent_id), 10) * 256 + get_byte(uuid_send(parent_id), 11)),
  CHECK (
    (kind = 'part' AND thread_id IS NULL AND post_id IS NULL AND target_revision_id IS NULL AND body_sha256 IS NULL)
    OR
    (kind = 'chapter' AND thread_id IS NOT NULL AND post_id IS NOT NULL AND target_revision_id IS NOT NULL
      AND body_sha256 IS NOT NULL AND octet_length(body_sha256) = 32)
  )
);
CREATE INDEX hosted_publication_staging_candidate_parent
  ON content.hosted_publication_staging_candidate(route, catalogue_id, stage_id, parent_id);

-- A receipt is small and bounded to one fixed page; it makes a lost response replay the same step.
CREATE TABLE content.hosted_publication_staging_step (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  step_id uuid NOT NULL,
  phase text NOT NULL CHECK (phase IN ('whole', 'selection', 'closure')),
  from_frontier bigint NOT NULL,
  to_frontier bigint NOT NULL,
  processed integer NOT NULL CHECK (processed BETWEEN 0 AND 20),
  result_state text NOT NULL CHECK (result_state IN ('more', 'ready', 'failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (route, catalogue_id, stage_id, step_id),
  FOREIGN KEY (route, catalogue_id, stage_id)
    REFERENCES content.hosted_publication_staging(route, catalogue_id, stage_id),
  CHECK (route = get_byte(uuid_send(step_id), 10) * 256 + get_byte(uuid_send(step_id), 11))
);

CREATE TABLE content.hosted_publication_staging_seal (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  input_version bigint NOT NULL CHECK (input_version >= 0),
  candidate_count bigint NOT NULL CHECK (candidate_count >= 0),
  sealed_at timestamptz NOT NULL CHECK (isfinite(sealed_at)),
  PRIMARY KEY (route, catalogue_id, stage_id),
  FOREIGN KEY (route, catalogue_id, stage_id)
    REFERENCES content.hosted_publication_staging(route, catalogue_id, stage_id)
);

CREATE FUNCTION content.guard_hosted_publication_staging_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hosted publication staging facts are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE FUNCTION content.guard_hosted_publication_staging_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'input_version' - 'input_count' - 'input_frozen_version'
        - 'input_frontier' - 'settled_input_count' - 'candidate_count' - 'duplicate_input_count'
        - 'unknown_input_count' - 'target_observation_count' - 'source_frontier' - 'source_exhausted'
        - 'closure_frontier' - 'closure_checked_count' - 'closure_missing_count' - 'failure' - 'sealed_at')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'status' - 'input_version' - 'input_count' - 'input_frozen_version'
        - 'input_frontier' - 'settled_input_count' - 'candidate_count' - 'duplicate_input_count'
        - 'unknown_input_count' - 'target_observation_count' - 'source_frontier' - 'source_exhausted'
        - 'closure_frontier' - 'closure_checked_count' - 'closure_missing_count' - 'failure' - 'sealed_at') THEN
    RAISE EXCEPTION 'Hosted publication staging binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER hosted_publication_staging_binding_immutable
  BEFORE UPDATE ON content.hosted_publication_staging
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_publication_staging_binding();
CREATE TRIGGER hosted_publication_staging_batch_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_publication_staging_batch
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_publication_staging_fact();
CREATE TRIGGER hosted_publication_staging_target_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_publication_staging_target
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_publication_staging_fact();
CREATE TRIGGER hosted_publication_staging_candidate_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_publication_staging_candidate
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_publication_staging_fact();
CREATE TRIGGER hosted_publication_staging_step_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_publication_staging_step
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_publication_staging_fact();
CREATE TRIGGER hosted_publication_staging_seal_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_publication_staging_seal
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_publication_staging_fact();

-- migrate:down
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM content.hosted_publication_staging
    WHERE status NOT IN ('cancelled', 'expired', 'failed')
    LIMIT 1
  ) THEN
    RAISE EXCEPTION 'Cannot roll back active hosted publication staging';
  END IF;
END;
$$;
DROP TRIGGER hosted_publication_staging_seal_immutable ON content.hosted_publication_staging_seal;
DROP TRIGGER hosted_publication_staging_step_immutable ON content.hosted_publication_staging_step;
DROP TRIGGER hosted_publication_staging_candidate_immutable ON content.hosted_publication_staging_candidate;
DROP TRIGGER hosted_publication_staging_target_immutable ON content.hosted_publication_staging_target;
DROP TRIGGER hosted_publication_staging_batch_immutable ON content.hosted_publication_staging_batch;
DROP TRIGGER hosted_publication_staging_binding_immutable ON content.hosted_publication_staging;
DROP FUNCTION content.guard_hosted_publication_staging_fact();
DROP FUNCTION content.guard_hosted_publication_staging_binding();
DROP TABLE content.hosted_publication_staging_seal;
DROP TABLE content.hosted_publication_staging_step;
DROP TABLE content.hosted_publication_staging_candidate;
DROP TABLE content.hosted_publication_staging_target;
DROP TABLE content.hosted_publication_staging_input;
DROP TABLE content.hosted_publication_staging_batch;
DROP INDEX content.hosted_publication_staging_expiry;
DROP TABLE content.hosted_publication_staging;
