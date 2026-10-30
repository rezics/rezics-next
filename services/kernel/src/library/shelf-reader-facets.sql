WITH candidates AS MATERIALIZED (
  SELECT type_id, n
  FROM library.shelf_count
  WHERE route = :route::integer AND account_id = :account_id::uuid
    AND bucket = 'all' AND type_id <> '00000000-0000-0000-0000-000000000000'::uuid AND n > 0
    AND type_id > :after::uuid
  ORDER BY type_id LIMIT :take::integer
)
SELECT candidates.type_id AS "typeId", candidates.n::text AS n,
       dictionary.json_byte_length::text AS "jsonBytes"
FROM candidates LEFT JOIN library.shelf_type_value AS dictionary
  ON dictionary.route = :route::integer AND dictionary.account_id = :account_id::uuid
  AND dictionary.type_id = candidates.type_id
ORDER BY candidates.type_id;
