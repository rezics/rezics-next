SELECT sequence_kind,
  node_id,
  left_id,
  right_id,
  tree_parent_id,
  height,
  node_count::text AS node_count,
  chapter_weight::text AS chapter_weight,
  chapter_count::text AS chapter_count
FROM content.hosted_version_builder_sequence_node
WHERE route = $1
  AND catalogue_id = $2
  AND input_id = $3
  AND (sequence_kind, node_id) > ($4, $5)
ORDER BY sequence_kind, node_id
LIMIT $6
