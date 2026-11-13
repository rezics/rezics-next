-- A sealed public manifest is copied into a private candidate in bounded
-- temporal-store pages. The existing publication remains selected throughout.
-- migrate:up
CREATE TABLE content.hosted_version_public_baseline (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  build_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  source_publication_id uuid NOT NULL,
  actor_binding bytea NOT NULL,
  placement_count bigint NOT NULL,
  root_count bigint NOT NULL,
  chapter_count bigint NOT NULL,
  sibling_root_id uuid,
  preorder_root_id uuid,
  chapter_root_id uuid,
  phase text NOT NULL,
  occurrence_after_ordinal bigint NOT NULL,
  node_after_kind text NOT NULL,
  node_after_id uuid NOT NULL,
  root_null_done boolean NOT NULL,
  root_after_parent_id uuid NOT NULL,
  occurrences_written bigint NOT NULL DEFAULT 0,
  nodes_written bigint NOT NULL DEFAULT 0,
  sibling_roots_written bigint NOT NULL DEFAULT 0,
  coverage_complete boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (route, catalogue_id, build_id),
  UNIQUE (route, catalogue_id, generation_id),
  FOREIGN KEY (route, catalogue_id, build_id)
    REFERENCES content.hosted_version_builder_source(route, catalogue_id, input_id),
  FOREIGN KEY (route, catalogue_id, generation_id)
    REFERENCES content.hosted_tree_generation(route, catalogue_id, generation_id),
  FOREIGN KEY (route, catalogue_id, source_publication_id)
    REFERENCES content.hosted_structure_revision(route, catalogue_id, revision_id),
  CHECK (
    route = get_byte(uuid_send(catalogue_id), 10) * 256 + get_byte(uuid_send(catalogue_id), 11)
    AND route = get_byte(uuid_send(build_id), 10) * 256 + get_byte(uuid_send(build_id), 11)
    AND route = get_byte(uuid_send(generation_id), 10) * 256 + get_byte(uuid_send(generation_id), 11)
    AND route = get_byte(uuid_send(thread_id), 10) * 256 + get_byte(uuid_send(thread_id), 11)
    AND route = get_byte(uuid_send(source_publication_id), 10) * 256 + get_byte(uuid_send(source_publication_id), 11)
    AND (node_after_id = '00000000-0000-0000-0000-000000000000'::uuid OR
      route = get_byte(uuid_send(node_after_id), 10) * 256 + get_byte(uuid_send(node_after_id), 11))
    AND (root_after_parent_id = '00000000-0000-0000-0000-000000000000'::uuid OR
      route = get_byte(uuid_send(root_after_parent_id), 10) * 256 + get_byte(uuid_send(root_after_parent_id), 11))
  ),
  CHECK (octet_length(actor_binding) = 32),
  CHECK (
    placement_count BETWEEN 0 AND 9007199254740991
    AND root_count BETWEEN 0 AND placement_count
    AND chapter_count BETWEEN 0 AND placement_count
    AND occurrences_written BETWEEN 0 AND placement_count
    AND nodes_written BETWEEN 0 AND 27021597764222973
    AND sibling_roots_written >= 0
    AND occurrence_after_ordinal BETWEEN -1 AND placement_count
  ),
  CHECK (phase IN ('occurrences', 'nodes', 'roots', 'complete')),
  CHECK (node_after_kind IN ('', 'chapters', 'preorder', 'siblings')),
  CHECK (status IN ('materializing', 'complete')),
  CHECK (
    (status = 'materializing' AND phase <> 'complete' AND NOT coverage_complete)
    OR (status = 'complete' AND phase = 'complete' AND coverage_complete)
  ),
  CHECK (isfinite(created_at) AND isfinite(updated_at))
);
CREATE INDEX hosted_version_public_baseline_status_idx
  ON content.hosted_version_public_baseline(route, catalogue_id, status, build_id);

-- Bottom-up subtree summaries let reverse-ordinal pages write occurrence
-- counts without rescanning the sealed manifest during finalization.
CREATE TABLE content.hosted_version_public_baseline_subtree (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  build_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  subtree_size bigint NOT NULL CHECK (subtree_size >= 0),
  chapter_count bigint NOT NULL CHECK (chapter_count >= 0),
  PRIMARY KEY (route, catalogue_id, build_id, occurrence_id),
  FOREIGN KEY (route, catalogue_id, build_id)
    REFERENCES content.hosted_version_public_baseline(route, catalogue_id, build_id),
  FOREIGN KEY (route, catalogue_id, occurrence_id)
    REFERENCES content.hosted_occurrence(route, catalogue_id, occurrence_id),
  CHECK (route = get_byte(uuid_send(occurrence_id), 10) * 256 + get_byte(uuid_send(occurrence_id), 11))
);

-- Receipts key each source frontier. Replaying a page never repeats writes.
CREATE TABLE content.hosted_version_public_baseline_page (
  route integer NOT NULL,
  catalogue_id uuid NOT NULL,
  build_id uuid NOT NULL,
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
    route, catalogue_id, build_id, from_phase, from_occurrence_after_ordinal,
    from_node_after_kind, from_node_after_id, from_root_null_done, from_root_after_parent_id
  ),
  FOREIGN KEY (route, catalogue_id, build_id)
    REFERENCES content.hosted_version_public_baseline(route, catalogue_id, build_id),
  CHECK (from_phase IN ('occurrences', 'nodes', 'roots')),
  CHECK (to_phase IN ('occurrences', 'nodes', 'roots', 'complete')),
  CHECK (isfinite(created_at))
);

-- migrate:down
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM content.hosted_version_public_baseline LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot roll back retained hosted public baseline candidates' USING ERRCODE='23514';
  END IF;
END;
$$;
DROP TABLE content.hosted_version_public_baseline_page;
DROP TABLE content.hosted_version_public_baseline_subtree;
DROP INDEX content.hosted_version_public_baseline_status_idx;
DROP TABLE content.hosted_version_public_baseline;
