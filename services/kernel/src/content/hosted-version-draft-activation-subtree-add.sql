INSERT INTO content.hosted_version_draft_activation_subtree
  (route, catalogue_id, input_id, occurrence_id, subtree_size, chapter_count, subtree_height)
VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7)
ON CONFLICT (route, catalogue_id, input_id, occurrence_id)
DO UPDATE SET
  subtree_size = content.hosted_version_draft_activation_subtree.subtree_size + EXCLUDED.subtree_size,
  chapter_count = content.hosted_version_draft_activation_subtree.chapter_count + EXCLUDED.chapter_count,
  subtree_height = GREATEST(content.hosted_version_draft_activation_subtree.subtree_height, EXCLUDED.subtree_height)
