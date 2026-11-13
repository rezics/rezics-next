SELECT occurrence_id,
  subtree_size::text AS subtree_size,
  chapter_count::text AS chapter_count,
  subtree_height
FROM content.hosted_version_draft_activation_subtree
WHERE route = $1
  AND catalogue_id = $2
  AND input_id = $3
  AND occurrence_id = $4
