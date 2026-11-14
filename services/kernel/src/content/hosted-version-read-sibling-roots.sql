SELECT requested.parent_id,latest.root_node_id,latest.sequence::text AS sequence
FROM (
  SELECT DISTINCT parent_id
  FROM unnest($4::uuid[]) AS selected(parent_id)
) requested
CROSS JOIN LATERAL (
  SELECT root.root_node_id,root.sequence
  FROM content.hosted_sibling_root_version root
  WHERE root.route=$1 AND root.catalogue_id=$2 AND root.generation_id=$3
    AND root.parent_is_null=(requested.parent_id IS NULL)
    AND root.parent_key=COALESCE(requested.parent_id,$5::uuid)
    AND root.sequence <= $6
  ORDER BY root.sequence DESC
  LIMIT 1
) latest
