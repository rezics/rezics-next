SELECT occurrence.occurrence_id,occurrence.parent_occurrence_id,occurrence.subtree_size::text AS subtree_size,
  occurrence.occurrence_state,occurrence.is_deleted,occurrence.sequence::text AS sequence,
  occurrence.subtree_height
FROM content.hosted_occurrence_state_version occurrence
WHERE occurrence.route=$1 AND occurrence.catalogue_id=$2 AND occurrence.generation_id=$3
  AND occurrence.occurrence_id=$4 AND occurrence.sequence <= $5
ORDER BY occurrence.sequence DESC
LIMIT 1
