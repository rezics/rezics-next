SELECT post_id AS id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
FROM content.post
WHERE route = :route::integer AND thread_id = :thread_id::uuid
  AND (created_at, post_id) < (
    SELECT created_at, post_id FROM content.post
    WHERE route = :route::integer AND thread_id = :thread_id::uuid AND post_id = :post_id::uuid
    LIMIT 1
  )
ORDER BY created_at DESC, post_id DESC
LIMIT 1;
