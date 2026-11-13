-- migrate:up
-- The ordered Book representation is additive and private. Legacy snapshots and sealed prefixes remain owners of
-- their current reads; no catalogue is copied or pointed at these generations by this migration.
CREATE TABLE content.hosted_tree_generation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  catalogue_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  generation_kind text NOT NULL CHECK (generation_kind IN ('draft', 'candidate')),
  head_sequence bigint NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  PRIMARY KEY (route, catalogue_id, generation_id),
  FOREIGN KEY (route, catalogue_id) REFERENCES content.hosted_catalogue(route, catalogue_id),
  CHECK (route = get_byte(uuid_send(catalogue_id), 10) * 256 + get_byte(uuid_send(catalogue_id), 11)),
  CHECK (route = get_byte(uuid_send(generation_id), 10) * 256 + get_byte(uuid_send(generation_id), 11))
);

CREATE TABLE content.hosted_tree_snapshot_version (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  preorder_root_id uuid,
  chapter_root_id uuid,
  placement_count bigint NOT NULL CHECK (placement_count >= 0),
  chapter_count bigint NOT NULL CHECK (chapter_count >= 0 AND chapter_count <= placement_count),
  PRIMARY KEY (route, catalogue_id, generation_id, sequence),
  FOREIGN KEY (route, catalogue_id, generation_id)
    REFERENCES content.hosted_tree_generation(route, catalogue_id, generation_id),
  FOREIGN KEY (route, catalogue_id, preorder_root_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, chapter_root_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  CHECK (preorder_root_id IS NULL OR
    route = get_byte(uuid_send(preorder_root_id), 10) * 256 + get_byte(uuid_send(preorder_root_id), 11)),
  CHECK (chapter_root_id IS NULL OR
    route = get_byte(uuid_send(chapter_root_id), 10) * 256 + get_byte(uuid_send(chapter_root_id), 11))
);

-- One stable logical occurrence may have a different temporal AVL node in each index and sequence.
CREATE TABLE content.hosted_order_node_version (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  index_kind text NOT NULL CHECK (index_kind IN ('sibling', 'preorder', 'chapter')),
  node_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  tree_parent_id uuid,
  node_state jsonb,
  is_deleted boolean NOT NULL,
  PRIMARY KEY (route, catalogue_id, generation_id, index_kind, node_id, sequence),
  FOREIGN KEY (route, catalogue_id, generation_id)
    REFERENCES content.hosted_tree_generation(route, catalogue_id, generation_id),
  FOREIGN KEY (route, catalogue_id, node_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, tree_parent_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  CHECK ((is_deleted AND node_state IS NULL) OR (NOT is_deleted AND node_state IS NOT NULL)),
  CHECK (route = get_byte(uuid_send(node_id), 10) * 256 + get_byte(uuid_send(node_id), 11)),
  CHECK (tree_parent_id IS NULL OR
    route = get_byte(uuid_send(tree_parent_id), 10) * 256 + get_byte(uuid_send(tree_parent_id), 11))
);
CREATE INDEX hosted_order_node_asof
  ON content.hosted_order_node_version
  (route, catalogue_id, generation_id, index_kind, node_id, sequence DESC);

-- Product containment and indexed-tree inverse edges have separate versioned storage.
CREATE TABLE content.hosted_occurrence_state_version (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  parent_occurrence_id uuid,
  subtree_size bigint NOT NULL CHECK (subtree_size >= 0),
  occurrence_state jsonb,
  is_deleted boolean NOT NULL,
  PRIMARY KEY (route, catalogue_id, generation_id, occurrence_id, sequence),
  FOREIGN KEY (route, catalogue_id, generation_id)
    REFERENCES content.hosted_tree_generation(route, catalogue_id, generation_id),
  FOREIGN KEY (route, catalogue_id, occurrence_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, parent_occurrence_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  CHECK ((is_deleted AND occurrence_state IS NULL AND parent_occurrence_id IS NULL AND subtree_size = 0)
      OR (NOT is_deleted AND occurrence_state IS NOT NULL AND subtree_size > 0)),
  CHECK (route = get_byte(uuid_send(occurrence_id), 10) * 256 + get_byte(uuid_send(occurrence_id), 11)),
  CHECK (parent_occurrence_id IS NULL OR
    route = get_byte(uuid_send(parent_occurrence_id), 10) * 256 + get_byte(uuid_send(parent_occurrence_id), 11))
);
CREATE INDEX hosted_occurrence_state_asof
  ON content.hosted_occurrence_state_version
  (route, catalogue_id, generation_id, occurrence_id, sequence DESC);

-- A separate null flag makes the top-level sibling root an equality-prefix seek as well.
CREATE TABLE content.hosted_sibling_root_version (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  parent_id uuid,
  parent_is_null boolean NOT NULL,
  parent_key uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence >= 0),
  root_node_id uuid,
  PRIMARY KEY (route, catalogue_id, generation_id, parent_is_null, parent_key, sequence),
  FOREIGN KEY (route, catalogue_id, generation_id)
    REFERENCES content.hosted_tree_generation(route, catalogue_id, generation_id),
  FOREIGN KEY (route, catalogue_id, parent_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, root_node_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  CHECK ((parent_is_null AND parent_id IS NULL AND parent_key='00000000-0000-0000-0000-000000000000'::uuid)
      OR (NOT parent_is_null AND parent_id IS NOT NULL AND parent_key=parent_id)),
  CHECK ((parent_id IS NULL OR
    route = get_byte(uuid_send(parent_id), 10) * 256 + get_byte(uuid_send(parent_id), 11))
      AND (root_node_id IS NULL OR
    route = get_byte(uuid_send(root_node_id), 10) * 256 + get_byte(uuid_send(root_node_id), 11)))
);
CREATE INDEX hosted_sibling_root_asof
  ON content.hosted_sibling_root_version
  (route, catalogue_id, generation_id, parent_is_null, parent_key, sequence DESC)
  INCLUDE (root_node_id);

CREATE FUNCTION content.guard_hosted_version_rows() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hosted version rows are append only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER hosted_tree_snapshot_version_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_tree_snapshot_version
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_version_rows();
CREATE TRIGGER hosted_order_node_version_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_order_node_version
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_version_rows();
CREATE TRIGGER hosted_occurrence_state_version_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_occurrence_state_version
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_version_rows();
CREATE TRIGGER hosted_sibling_root_version_immutable
  BEFORE UPDATE OR DELETE ON content.hosted_sibling_root_version
  FOR EACH ROW EXECUTE FUNCTION content.guard_hosted_version_rows();

CREATE FUNCTION content.advance_hosted_version_head() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER hosted_tree_generation_head_step
  BEFORE UPDATE ON content.hosted_tree_generation
  FOR EACH ROW EXECUTE FUNCTION content.advance_hosted_version_head();

-- migrate:down
DROP TABLE content.hosted_sibling_root_version;
DROP TABLE content.hosted_occurrence_state_version;
DROP TABLE content.hosted_order_node_version;
DROP TABLE content.hosted_tree_snapshot_version;
DROP TABLE content.hosted_tree_generation;
DROP FUNCTION content.advance_hosted_version_head();
DROP FUNCTION content.guard_hosted_version_rows();
