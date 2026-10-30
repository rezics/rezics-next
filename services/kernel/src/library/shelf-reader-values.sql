SELECT type_id AS "typeId", full_type AS type
FROM library.shelf_type_value
WHERE route = :route::integer AND account_id = :account_id::uuid AND type_id = ANY(:type_ids::uuid[]);
