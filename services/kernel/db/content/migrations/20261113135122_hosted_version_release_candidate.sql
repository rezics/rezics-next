-- migrate:up
-- Whole-Book receiving writes only to this private control state and an isolated native candidate generation.
CREATE TABLE content.hosted_version_release_candidate (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  initiator_account_id uuid NOT NULL,
  owner_epoch bigint NOT NULL CHECK (owner_epoch >= 0),
  source_revision_id uuid NOT NULL,
  expected_head_revision_id uuid NOT NULL,
  expected_publication_id uuid,
  mode text NOT NULL CHECK (mode IN ('whole','selection')),
  input_version bigint NOT NULL CHECK (input_version >= 0),
  source_candidate_count bigint NOT NULL CHECK (source_candidate_count BETWEEN 0 AND 9007199254740991),
  source_sealed_at timestamptz NOT NULL CHECK (isfinite(source_sealed_at)),
  after_source_order bigint NOT NULL DEFAULT -1 CHECK (after_source_order BETWEEN -1 AND 9007199254740990),
  placement_count bigint NOT NULL DEFAULT 0 CHECK (placement_count BETWEEN 0 AND 9007199254740991),
  chapter_count bigint NOT NULL DEFAULT 0 CHECK (chapter_count BETWEEN 0 AND placement_count),
  root_next_position bigint NOT NULL DEFAULT 0 CHECK (root_next_position BETWEEN 0 AND 9007199254740991),
  root_sibling_root_id uuid,
  preorder_root_id uuid,
  chapter_root_id uuid,
  active_path jsonb NOT NULL DEFAULT '[]'::jsonb,
  generation_sequence bigint NOT NULL DEFAULT 0 CHECK (generation_sequence >= 0),
  coverage_complete boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','sealed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(updated_at)),
  sealed_at timestamptz CHECK (sealed_at IS NULL OR isfinite(sealed_at)),
  PRIMARY KEY (route,catalogue_id,stage_id),
  UNIQUE (route,catalogue_id,generation_id),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_publication_staging_seal(route,catalogue_id,stage_id),
  FOREIGN KEY (route,catalogue_id,generation_id)
    REFERENCES content.hosted_tree_generation(route,catalogue_id,generation_id),
  FOREIGN KEY (route,catalogue_id,source_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  FOREIGN KEY (route,catalogue_id,expected_head_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  FOREIGN KEY (route,catalogue_id,expected_publication_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  CHECK (
    route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)
    AND route=get_byte(uuid_send(stage_id),10)*256+get_byte(uuid_send(stage_id),11)
    AND route=get_byte(uuid_send(generation_id),10)*256+get_byte(uuid_send(generation_id),11)
    AND route=get_byte(uuid_send(initiator_account_id),10)*256+get_byte(uuid_send(initiator_account_id),11)
    AND route=get_byte(uuid_send(source_revision_id),10)*256+get_byte(uuid_send(source_revision_id),11)
    AND route=get_byte(uuid_send(expected_head_revision_id),10)*256+get_byte(uuid_send(expected_head_revision_id),11)
    AND (expected_publication_id IS NULL OR
      route=get_byte(uuid_send(expected_publication_id),10)*256+get_byte(uuid_send(expected_publication_id),11))
  ),
  CHECK (expected_head_revision_id=source_revision_id),
  CHECK (jsonb_typeof(active_path)='array' AND jsonb_array_length(active_path)<=16),
  CHECK ((status='building' AND sealed_at IS NULL) OR
    (status='sealed' AND sealed_at IS NOT NULL AND coverage_complete)),
  CHECK (NOT coverage_complete OR placement_count=source_candidate_count)
);
CREATE INDEX hosted_version_release_candidate_state_idx
  ON content.hosted_version_release_candidate(route,catalogue_id,status,stage_id);

-- A page key is the durable source-order cursor. Receipts preserve the exact temporal snapshot sequence for replay.
CREATE TABLE content.hosted_version_release_candidate_page (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  from_source_order bigint NOT NULL CHECK (from_source_order BETWEEN -1 AND 9007199254740990),
  to_source_order bigint NOT NULL CHECK (to_source_order BETWEEN -1 AND 9007199254740990),
  processed integer NOT NULL CHECK (processed BETWEEN 0 AND 20),
  to_generation_sequence bigint NOT NULL CHECK (to_generation_sequence >= 0),
  to_placement_count bigint NOT NULL CHECK (to_placement_count BETWEEN 0 AND 9007199254740991),
  to_root_count bigint NOT NULL CHECK (to_root_count BETWEEN 0 AND 9007199254740991),
  to_chapter_count bigint NOT NULL CHECK (to_chapter_count BETWEEN 0 AND to_placement_count),
  coverage_complete boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (route,catalogue_id,stage_id,from_source_order),
  FOREIGN KEY (route,catalogue_id,stage_id)
    REFERENCES content.hosted_version_release_candidate(route,catalogue_id,stage_id),
  CHECK ((processed=0 AND to_source_order=from_source_order) OR
    (processed>0 AND to_source_order>from_source_order))
);

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_version_release_candidate LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back retained hosted version release candidates' USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TABLE content.hosted_version_release_candidate_page;
DROP INDEX content.hosted_version_release_candidate_state_idx;
DROP TABLE content.hosted_version_release_candidate;
