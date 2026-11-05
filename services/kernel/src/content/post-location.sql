WITH input AS (
  SELECT :route::integer AS route, :thread_id::uuid AS thread_id, :post_id::uuid AS post_id
)
SELECT predecessor.post_id AS id,
       to_char(predecessor.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
FROM content.post AS predecessor
CROSS JOIN input
WHERE predecessor.route = input.route AND predecessor.thread_id = input.thread_id
  AND (predecessor.created_at, predecessor.post_id) < (
    SELECT target.created_at, target.post_id FROM content.post AS target
    WHERE target.route = input.route AND target.thread_id = input.thread_id AND target.post_id = input.post_id
    LIMIT 1
  )
ORDER BY predecessor.created_at DESC, predecessor.post_id DESC
LIMIT 1;
