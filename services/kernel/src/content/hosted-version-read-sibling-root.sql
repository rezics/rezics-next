SELECT root.parent_id,root.root_node_id,root.sequence::text AS sequence
FROM content.hosted_sibling_root_version root
WHERE root.route=$1 AND root.catalogue_id=$2 AND root.generation_id=$3
  AND root.parent_is_null=$4 AND root.parent_key=$5 AND root.sequence <= $6
ORDER BY root.sequence DESC
LIMIT 1
