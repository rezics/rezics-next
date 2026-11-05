SELECT r.root_node_id::text AS "nodeId", r.primary_type_id::text AS "typeId",
       v.full_type COLLATE "C" = :full_type::text COLLATE "C" AS equal
FROM library.shelf_type_root AS r
JOIN library.shelf_type_value AS v USING (route, account_id)
WHERE r.route = :route::integer AND r.account_id = :account_id::uuid AND r.digest = :digest::bytea
  AND v.type_id = r.primary_type_id
LIMIT 1;
