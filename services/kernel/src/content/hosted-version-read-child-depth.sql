WITH selected AS (
  SELECT $1::integer AS route,$2::uuid AS catalogue_id,$3::uuid AS generation_id,
    $4::uuid AS parent_occurrence_id,$5::bigint AS sequence,$6::uuid[] AS excluded_occurrence_ids
)
SELECT child.occurrence_id,
  COALESCE(child.subtree_height,content.hosted_occurrence_subtree_height(child.occurrence_state)) AS subtree_height
FROM selected
JOIN content.hosted_occurrence_state_version child
  ON child.route=selected.route AND child.catalogue_id=selected.catalogue_id
  AND child.generation_id=selected.generation_id
WHERE child.parent_occurrence_id IS NOT DISTINCT FROM selected.parent_occurrence_id
  AND child.sequence <= selected.sequence AND NOT child.is_deleted
  AND COALESCE(child.subtree_height,content.hosted_occurrence_subtree_height(child.occurrence_state)) IS NOT NULL
  AND child.occurrence_id <> ALL(selected.excluded_occurrence_ids)
  AND NOT EXISTS (
    SELECT 1
    FROM content.hosted_occurrence_state_version newer
    WHERE newer.route=child.route AND newer.catalogue_id=child.catalogue_id
      AND newer.generation_id=child.generation_id AND newer.occurrence_id=child.occurrence_id
      AND newer.sequence > child.sequence AND newer.sequence <= selected.sequence
  )
ORDER BY COALESCE(child.subtree_height,content.hosted_occurrence_subtree_height(child.occurrence_state)) DESC,
  child.occurrence_id
LIMIT 1
