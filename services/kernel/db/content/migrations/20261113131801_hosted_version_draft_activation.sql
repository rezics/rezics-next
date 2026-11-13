-- migrate:up
-- Private bridge from one sealed builder onto a draft generation. Pages copy
-- existing builder facts through the temporal store; the catalogue head and
-- publication pointer stay on the source until the verified CAS.
CREATE TABLE content.hosted_version_draft_activation (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  source_revision_id uuid NOT NULL,
  expected_revision_id uuid NOT NULL,
  placement_count bigint NOT NULL,
  chapter_count bigint NOT NULL,
  root_count bigint NOT NULL,
  sibling_root_id uuid,
  preorder_root_id uuid,
  chapter_root_id uuid,
  phase text NOT NULL,
  occurrence_after_ordinal bigint NOT NULL,
  node_after_kind text NOT NULL,
  node_after_id uuid NOT NULL,
  root_null_done boolean NOT NULL,
  root_after_parent_id uuid NOT NULL,
  coverage_complete boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (route, catalogue_id, input_id),
  UNIQUE (route, catalogue_id, generation_id),
  UNIQUE (route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id, input_id)
    REFERENCES content.hosted_version_builder(route, catalogue_id, input_id),
  FOREIGN KEY (route, catalogue_id, generation_id)
    REFERENCES content.hosted_tree_generation(route, catalogue_id, generation_id),
  FOREIGN KEY (route, catalogue_id, source_revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  FOREIGN KEY (route, catalogue_id, expected_revision_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  CHECK (
    route = get_byte(uuid_send(catalogue_id), 10) * 256 + get_byte(uuid_send(catalogue_id), 11)
    AND route = get_byte(uuid_send(input_id), 10) * 256 + get_byte(uuid_send(input_id), 11)
    AND route = get_byte(uuid_send(generation_id), 10) * 256 + get_byte(uuid_send(generation_id), 11)
    AND route = get_byte(uuid_send(revision_id), 10) * 256 + get_byte(uuid_send(revision_id), 11)
  ),
  CHECK (source_revision_id = expected_revision_id),
  CHECK (
    placement_count BETWEEN 1 AND 9007199254740991
    AND chapter_count BETWEEN 0 AND placement_count
    AND root_count BETWEEN 1 AND placement_count
  ),
  CHECK (phase IN ('occurrences', 'nodes', 'roots', 'complete')),
  CHECK (status IN ('materializing', 'complete', 'activated')),
  CHECK (occurrence_after_ordinal BETWEEN -1 AND placement_count),
  CHECK (node_after_kind IN ('', 'chapters', 'preorder', 'siblings')),
  CHECK (
    (status = 'materializing' AND phase <> 'complete' AND NOT coverage_complete)
    OR (status IN ('complete', 'activated') AND phase = 'complete' AND coverage_complete)
  ),
  CHECK (isfinite(created_at) AND isfinite(updated_at))
);
CREATE INDEX hosted_version_draft_activation_status_idx
  ON content.hosted_version_draft_activation(route, catalogue_id, status, input_id);

-- Durable parent accumulators so reverse-preorder pages can finish subtree
-- counts without a final scan of the candidate.
CREATE TABLE content.hosted_version_draft_activation_subtree (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  subtree_size bigint NOT NULL CHECK (subtree_size >= 0),
  chapter_count bigint NOT NULL CHECK (chapter_count >= 0),
  subtree_height integer NOT NULL CHECK (subtree_height BETWEEN -1 AND 16),
  PRIMARY KEY (route, catalogue_id, input_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, input_id)
    REFERENCES content.hosted_version_draft_activation(route, catalogue_id, input_id),
  CHECK (route = get_byte(uuid_send(occurrence_id), 10) * 256 + get_byte(uuid_send(occurrence_id), 11))
);

-- One source cursor is applied at most once. Receipts hold only the two
-- cursors and counts; replay never re-writes store rows.
CREATE TABLE content.hosted_version_draft_activation_page (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  input_id uuid NOT NULL,
  from_phase text NOT NULL,
  from_occurrence_after_ordinal bigint NOT NULL,
  from_node_after_kind text NOT NULL,
  from_node_after_id uuid NOT NULL,
  from_root_null_done boolean NOT NULL,
  from_root_after_parent_id uuid NOT NULL,
  to_phase text NOT NULL,
  to_occurrence_after_ordinal bigint NOT NULL,
  to_node_after_kind text NOT NULL,
  to_node_after_id uuid NOT NULL,
  to_root_null_done boolean NOT NULL,
  to_root_after_parent_id uuid NOT NULL,
  occurrences_written integer NOT NULL CHECK (occurrences_written BETWEEN 0 AND 20),
  nodes_written integer NOT NULL CHECK (nodes_written BETWEEN 0 AND 20),
  sibling_roots_written integer NOT NULL CHECK (sibling_roots_written BETWEEN 0 AND 20),
  coverage_complete boolean NOT NULL,
  generation_sequence bigint NOT NULL CHECK (generation_sequence >= 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (
    route, catalogue_id, input_id, from_phase, from_occurrence_after_ordinal,
    from_node_after_kind, from_node_after_id, from_root_null_done, from_root_after_parent_id
  ),
  FOREIGN KEY (route, catalogue_id, input_id)
    REFERENCES content.hosted_version_draft_activation(route, catalogue_id, input_id),
  CHECK (from_phase IN ('occurrences', 'nodes', 'roots')),
  CHECK (to_phase IN ('occurrences', 'nodes', 'roots', 'complete')),
  CHECK (isfinite(created_at))
);

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_version_draft_activation LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back hosted version draft activations with retained state' USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TABLE content.hosted_version_draft_activation_page;
DROP TABLE content.hosted_version_draft_activation_subtree;
DROP INDEX content.hosted_version_draft_activation_status_idx;
DROP TABLE content.hosted_version_draft_activation;
