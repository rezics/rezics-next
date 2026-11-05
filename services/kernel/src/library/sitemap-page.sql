WITH input AS NOT MATERIALIZED (
  SELECT :partition_no::integer AS partition_no
)
SELECT collection.route AS route,
       collection.collection_id::text AS id,
       COALESCE(to_char(collection.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '') AS "updatedAt"
FROM library.collection AS collection
  CROSS JOIN input
WHERE collection.route >= input.partition_no * 16
  AND collection.route < (input.partition_no + 1) * 16
  AND (collection.route, collection.collection_id) > (:after_route::integer, :after_id::uuid)
  AND collection.state = 'active'
  AND collection.visibility = 'public'
ORDER BY collection.route ASC, collection.collection_id ASC
LIMIT :page_limit::integer;
