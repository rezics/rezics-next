-- migrate:up
-- A builder is isolated receiving state for one retained migration input. It
-- never advances the live hosted catalogue's head or publication pointers.
CREATE TABLE content.hosted_version_builder (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('snapshot','prefix')),
  base_revision_id uuid NOT NULL,
  base_placement_count bigint NOT NULL,
  base_root_count bigint NOT NULL,
  source_high_water bigint NOT NULL,
  expected_placement_count bigint NOT NULL,
  frontier_segment text NOT NULL,
  after_ordinal bigint NOT NULL DEFAULT -1,
  after_offset bigint NOT NULL DEFAULT -1,
  root_sibling_root_id uuid,
  preorder_root_id uuid,
  chapter_root_id uuid,
  root_next_position bigint NOT NULL DEFAULT 0,
  active_ancestors jsonb NOT NULL DEFAULT '[]'::jsonb,
  coverage_complete boolean NOT NULL DEFAULT false,
  source_current boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'building',
  sealed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (route,catalogue_id,input_id),
  FOREIGN KEY (route,catalogue_id) REFERENCES content.hosted_catalogue(route,catalogue_id),
  FOREIGN KEY (route,catalogue_id,input_id)
    REFERENCES content.hosted_migration_input(route,catalogue_id,input_id),
  FOREIGN KEY (route,catalogue_id,source_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  FOREIGN KEY (route,catalogue_id,base_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  CHECK (
    route=get_byte(uuid_send(catalogue_id),10)*256+get_byte(uuid_send(catalogue_id),11)
    AND route=get_byte(uuid_send(input_id),10)*256+get_byte(uuid_send(input_id),11)
  ),
  CHECK (
    base_placement_count BETWEEN 0 AND 9007199254740991
    AND base_root_count BETWEEN 0 AND base_placement_count
    AND source_high_water BETWEEN -1 AND 9007199254740990
    AND expected_placement_count BETWEEN 0 AND 9007199254740991
    AND expected_placement_count=base_placement_count
      + CASE WHEN source_kind='prefix' AND source_high_water>=0 THEN source_high_water+1 ELSE 0 END
    AND ((source_kind='snapshot' AND source_revision_id=base_revision_id AND source_high_water=-1)
      OR source_kind='prefix')
  ),
  CHECK (
    frontier_segment IN ('base','prefix','complete')
    AND after_ordinal BETWEEN -1 AND base_placement_count
    AND after_offset BETWEEN -1 AND source_high_water
    AND (frontier_segment<>'prefix' OR source_kind='prefix')
    AND (frontier_segment<>'complete' OR coverage_complete OR expected_placement_count=0)
  ),
  CHECK (
    jsonb_typeof(active_ancestors)='array'
    AND jsonb_array_length(active_ancestors)<=16
    AND root_next_position BETWEEN 0 AND 9007199254740991
  ),
  CHECK ((status='building' AND sealed_at IS NULL) OR (status='sealed' AND sealed_at IS NOT NULL AND coverage_complete)),
  CHECK (isfinite(created_at) AND isfinite(updated_at) AND (sealed_at IS NULL OR isfinite(sealed_at)))
);
CREATE INDEX hosted_version_builder_state_idx
  ON content.hosted_version_builder(route,catalogue_id,status,input_id);

-- Point facts retain source identity and disclosed metadata independently of
-- the compact resumable state. A redacted title or unavailable target is NULL.
CREATE TABLE content.hosted_version_builder_point (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  source_ordinal bigint NOT NULL CHECK (source_ordinal BETWEEN 0 AND 9007199254740990),
  address_segment text NOT NULL CHECK (address_segment IN ('base','prefix')),
  source_revision_id uuid,
  source_stream_id uuid,
  source_offset bigint,
  source_address_ordinal bigint,
  occurrence_id uuid NOT NULL,
  parent_id uuid,
  position bigint NOT NULL CHECK (position BETWEEN 0 AND 9007199254740990),
  kind text NOT NULL CHECK (kind IN ('part','chapter')),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 256),
  target_thread_id uuid,
  target_post_id uuid,
  target_revision_id uuid,
  target_sha256 bytea CHECK (target_sha256 IS NULL OR octet_length(target_sha256)=32),
  PRIMARY KEY (route,catalogue_id,input_id,source_ordinal),
  UNIQUE (route,catalogue_id,input_id,occurrence_id),
  FOREIGN KEY (route,catalogue_id,input_id)
    REFERENCES content.hosted_version_builder(route,catalogue_id,input_id),
  FOREIGN KEY (route,catalogue_id,input_id,parent_id)
    REFERENCES content.hosted_version_builder_point(route,catalogue_id,input_id,occurrence_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (route,catalogue_id,source_revision_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  FOREIGN KEY (route,catalogue_id,source_stream_id)
    REFERENCES content.hosted_structure_revision(route,catalogue_id,revision_id),
  CHECK (
    route=get_byte(uuid_send(occurrence_id),10)*256+get_byte(uuid_send(occurrence_id),11)
    AND (parent_id IS NULL OR route=get_byte(uuid_send(parent_id),10)*256+get_byte(uuid_send(parent_id),11))
  ),
  CHECK (
    (address_segment='base' AND source_revision_id IS NOT NULL AND source_stream_id IS NULL
      AND source_offset IS NULL AND source_address_ordinal IS NOT NULL
      AND source_address_ordinal=source_ordinal)
    OR
    (address_segment='prefix' AND source_revision_id IS NULL AND source_stream_id IS NOT NULL
      AND source_offset IS NOT NULL AND source_offset>=0 AND source_address_ordinal IS NULL)
  ),
  CHECK (
    (kind='part' AND target_thread_id IS NULL AND target_post_id IS NULL
      AND target_revision_id IS NULL AND target_sha256 IS NULL)
    OR
    (kind='chapter' AND (
      (target_thread_id IS NULL AND target_post_id IS NULL AND target_revision_id IS NULL AND target_sha256 IS NULL)
      OR
      (target_thread_id IS NOT NULL AND target_post_id IS NOT NULL AND target_revision_id IS NOT NULL
        AND target_sha256 IS NOT NULL)
    ))
  )
);
CREATE INDEX hosted_version_builder_point_parent_idx
  ON content.hosted_version_builder_point(route,catalogue_id,input_id,parent_id,position);

-- One root per parent sibling group, including the root-level group whose
-- parent_id is NULL. The active path copy in the header is depth bounded.
CREATE TABLE content.hosted_version_builder_sibling_root (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  parent_id uuid,
  root_id uuid NOT NULL,
  next_position bigint NOT NULL CHECK (next_position BETWEEN 1 AND 9007199254740991),
  FOREIGN KEY (route,catalogue_id,input_id)
    REFERENCES content.hosted_version_builder(route,catalogue_id,input_id),
  FOREIGN KEY (route,catalogue_id,input_id,parent_id)
    REFERENCES content.hosted_version_builder_point(route,catalogue_id,input_id,occurrence_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (route,catalogue_id,input_id,root_id)
    REFERENCES content.hosted_version_builder_point(route,catalogue_id,input_id,occurrence_id)
    DEFERRABLE INITIALLY DEFERRED,
  UNIQUE NULLS NOT DISTINCT (route,catalogue_id,input_id,parent_id),
  CHECK (parent_id IS NULL OR route=get_byte(uuid_send(parent_id),10)*256+get_byte(uuid_send(parent_id),11)),
  CHECK (route=get_byte(uuid_send(root_id),10)*256+get_byte(uuid_send(root_id),11))
);

-- The three indexes share stable occurrence IDs but keep separate AVL links.
CREATE TABLE content.hosted_version_builder_sequence_node (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  sequence_kind text NOT NULL CHECK (sequence_kind IN ('siblings','preorder','chapters')),
  node_id uuid NOT NULL,
  left_id uuid,
  right_id uuid,
  tree_parent_id uuid,
  height integer NOT NULL CHECK (height > 0),
  node_count bigint NOT NULL CHECK (node_count > 0),
  chapter_weight smallint NOT NULL DEFAULT 0 CHECK (chapter_weight IN (0,1)),
  chapter_count bigint NOT NULL CHECK (chapter_count BETWEEN 0 AND node_count),
  PRIMARY KEY (route,catalogue_id,input_id,sequence_kind,node_id),
  FOREIGN KEY (route,catalogue_id,input_id)
    REFERENCES content.hosted_version_builder(route,catalogue_id,input_id),
  FOREIGN KEY (route,catalogue_id,input_id,node_id)
    REFERENCES content.hosted_version_builder_point(route,catalogue_id,input_id,occurrence_id),
  FOREIGN KEY (route,catalogue_id,input_id,sequence_kind,left_id)
    REFERENCES content.hosted_version_builder_sequence_node(route,catalogue_id,input_id,sequence_kind,node_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (route,catalogue_id,input_id,sequence_kind,right_id)
    REFERENCES content.hosted_version_builder_sequence_node(route,catalogue_id,input_id,sequence_kind,node_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (route,catalogue_id,input_id,sequence_kind,tree_parent_id)
    REFERENCES content.hosted_version_builder_sequence_node(route,catalogue_id,input_id,sequence_kind,node_id)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (route=get_byte(uuid_send(node_id),10)*256+get_byte(uuid_send(node_id),11)),
  CHECK (left_id IS NULL OR route=get_byte(uuid_send(left_id),10)*256+get_byte(uuid_send(left_id),11)),
  CHECK (right_id IS NULL OR route=get_byte(uuid_send(right_id),10)*256+get_byte(uuid_send(right_id),11)),
  CHECK (tree_parent_id IS NULL OR route=get_byte(uuid_send(tree_parent_id),10)*256+get_byte(uuid_send(tree_parent_id),11))
);

-- A source cursor is applied at most once. The receipt contains only its two
-- cursors and counts; replay never re-runs tree writes.
CREATE TABLE content.hosted_version_builder_page (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  from_segment text NOT NULL CHECK (from_segment IN ('base','prefix')),
  from_after_ordinal bigint NOT NULL DEFAULT -1,
  from_after_offset bigint NOT NULL DEFAULT -1,
  to_segment text NOT NULL CHECK (to_segment IN ('base','prefix','complete')),
  to_after_ordinal bigint NOT NULL DEFAULT -1,
  to_after_offset bigint NOT NULL DEFAULT -1,
  processed integer NOT NULL CHECK (processed BETWEEN 0 AND 20),
  source_current boolean NOT NULL CHECK (source_current),
  coverage_complete boolean NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (route,catalogue_id,input_id,from_segment,from_after_ordinal,from_after_offset),
  FOREIGN KEY (route,catalogue_id,input_id)
    REFERENCES content.hosted_version_builder(route,catalogue_id,input_id),
  CHECK (from_segment<>'prefix' OR from_after_ordinal=-1),
  CHECK (from_segment<>'base' OR from_after_offset=-1),
  CHECK (to_segment<>'prefix' OR to_after_ordinal=-1),
  CHECK (to_segment<>'base' OR to_after_offset=-1),
  CHECK (coverage_complete=(to_segment='complete')),
  CHECK (isfinite(created_at))
);

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_version_builder LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back hosted version builders with retained state' USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TABLE content.hosted_version_builder_page;
DROP TABLE content.hosted_version_builder_sequence_node;
DROP TABLE content.hosted_version_builder_sibling_root;
DROP TABLE content.hosted_version_builder_point;
DROP INDEX content.hosted_version_builder_state_idx;
DROP TABLE content.hosted_version_builder;
