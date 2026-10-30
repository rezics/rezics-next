SELECT type_id AS "typeId",
       convert_to(full_type, 'UTF8') = convert_to(:full_type::text, 'UTF8') AS equal
FROM library.shelf_type_value
WHERE route = :route::integer AND account_id = :account_id::uuid AND type_id = :type_id::uuid
LIMIT 1;
