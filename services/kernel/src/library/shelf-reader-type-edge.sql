SELECT node_id AS "nodeId", terminal_type_id AS "typeId"
FROM library.shelf_type_node
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND parent_id = :parent_id::uuid AND chunk = :chunk::bytea
LIMIT 1;
