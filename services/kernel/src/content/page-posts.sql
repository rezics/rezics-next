SELECT post_id AS id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
FROM content.post
WHERE route = :route::integer AND thread_id = :thread_id::uuid
  AND (created_at, post_id) > (:at::timestamptz, :post_id::uuid)
ORDER BY created_at ASC, post_id ASC
LIMIT :limit::integer;
