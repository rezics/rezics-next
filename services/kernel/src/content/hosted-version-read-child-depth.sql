SELECT child.occurrence_id,
  COALESCE(child.subtree_height,content.hosted_occurrence_subtree_height(child.occurrence_state)) AS subtree_height
FROM content.hosted_occurrence_state_version child
WHERE child.route=$1 AND child.catalogue_id=$2 AND child.generation_id=$3
  AND child.parent_occurrence_id IS NOT DISTINCT FROM $4
  AND child.sequence <= $5 AND NOT child.is_deleted
  AND COALESCE(child.subtree_height,content.hosted_occurrence_subtree_height(child.occurrence_state)) IS NOT NULL
  AND child.occurrence_id <> ALL($6::uuid[])
  AND NOT EXISTS (
    SELECT 1
    FROM content.hosted_occurrence_state_version newer
    WHERE newer.route=child.route AND newer.catalogue_id=child.catalogue_id
      AND newer.generation_id=child.generation_id AND newer.occurrence_id=child.occurrence_id
      AND newer.sequence > child.sequence AND newer.sequence <= $5
  )
ORDER BY COALESCE(child.subtree_height,content.hosted_occurrence_subtree_height(child.occurrence_state)) DESC,
  child.occurrence_id
LIMIT 1
