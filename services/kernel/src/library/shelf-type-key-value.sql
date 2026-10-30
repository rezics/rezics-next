SELECT type_id::text AS "typeId"
FROM library.shelf_type_value
WHERE route = :route::integer AND account_id = :account_id::uuid AND type_id = :type_id::uuid
  AND full_type COLLATE "C" = :full_type::text COLLATE "C";
