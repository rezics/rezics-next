WITH input AS (
  SELECT :route::integer AS route, :account_id::uuid AS account_id
), candidates AS MATERIALIZED (
  SELECT type_id, n
  FROM library.shelf_count CROSS JOIN input
  WHERE shelf_count.route = input.route AND shelf_count.account_id = input.account_id
    AND shelf_count.generation_id = :generation_id::uuid
    AND bucket = 'all' AND type_id <> '00000000-0000-0000-0000-000000000000'::uuid AND n > 0
    AND type_id > :after::uuid
  ORDER BY type_id LIMIT :take::integer
)
SELECT candidates.type_id AS "typeId", candidates.n::text AS n,
       dictionary.json_byte_length::text AS "jsonBytes"
FROM candidates CROSS JOIN input LEFT JOIN library.shelf_type_value AS dictionary
  ON dictionary.route = input.route AND dictionary.account_id = input.account_id
  AND dictionary.type_id = candidates.type_id
ORDER BY candidates.type_id;
