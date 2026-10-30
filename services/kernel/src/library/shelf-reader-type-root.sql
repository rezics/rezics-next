SELECT primary_type_id AS "typeId", root_node_id AS "nodeId"
FROM library.shelf_type_root
WHERE route = :route::integer AND account_id = :account_id::uuid AND digest = :digest::bytea
LIMIT 1;
