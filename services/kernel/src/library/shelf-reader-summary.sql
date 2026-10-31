WITH input AS (
  SELECT :type_id::nullable(uuid) AS type_id
), keys AS (
  SELECT bucket, '00000000-0000-0000-0000-000000000000'::uuid AS type_id
  FROM unnest(ARRAY['all','in_progress','planned','completed','paused','dropped','collections']) AS buckets(bucket)
  UNION ALL
  SELECT bucket, input.type_id
  FROM input CROSS JOIN unnest(ARRAY['all','in_progress','planned','completed','paused','dropped']) AS buckets(bucket)
  WHERE input.type_id IS NOT NULL
)
SELECT keys.bucket, keys.type_id AS "typeId", COALESCE(counts.n, 0)::text AS n
FROM keys LEFT JOIN library.shelf_count AS counts
  ON counts.route = :route::integer AND counts.account_id = :account_id::uuid
  AND counts.generation_id = :generation_id::uuid
  AND counts.bucket = keys.bucket AND counts.type_id = keys.type_id;
