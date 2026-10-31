SELECT type_id AS "typeId", full_type AS type
FROM library.shelf_type_value AS dictionary
WHERE route = :route::integer AND account_id = :account_id::uuid AND type_id = ANY(:type_ids::uuid[])
  AND EXISTS (
    SELECT 1 FROM library.shelf_count AS counts
    WHERE counts.route = dictionary.route AND counts.account_id = dictionary.account_id
      AND counts.generation_id = :generation_id::uuid AND counts.bucket = 'all'
      AND counts.type_id = dictionary.type_id AND counts.n > 0
  );

