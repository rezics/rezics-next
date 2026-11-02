WITH input AS (
  SELECT :route::integer AS route, :thread_id::uuid AS thread_id
)
SELECT post_id AS id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
FROM content.post
WHERE route = (SELECT route FROM input) AND thread_id = (SELECT thread_id FROM input)
  AND (created_at, post_id) < (
    SELECT created_at, post_id FROM content.post
    WHERE route = (SELECT route FROM input) AND thread_id = (SELECT thread_id FROM input) AND post_id = :post_id::uuid
    LIMIT 1
  )
ORDER BY created_at DESC, post_id DESC
LIMIT 1;
