SELECT node.node_id,node.tree_parent_id,node.node_state,node.is_deleted,node.sequence::text AS sequence,
  node.subtree_height,node.maximum_subtree_height,node.maximum_subtree_occurrence_id
FROM content.hosted_order_node_version node
WHERE node.route=$1 AND node.catalogue_id=$2 AND node.generation_id=$3
  AND node.index_kind=$4 AND node.node_id=$5 AND node.sequence <= $6
ORDER BY node.sequence DESC
LIMIT 1
