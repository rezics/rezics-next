-- The newest listed thread of a board, looked for among the board's `:limit` newest candidates only.
SELECT to_char(newest.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_modified
FROM (
  SELECT thread_id, created_at
  FROM content.board_thread
  WHERE route = :route::integer AND board_id = :board_id::uuid
  ORDER BY created_at DESC, thread_id DESC
  LIMIT :limit::integer
) AS newest
JOIN content.thread AS thread
  ON thread.route = get_byte(uuid_send(newest.thread_id), 10) * 256 + get_byte(uuid_send(newest.thread_id), 11)
 AND thread.thread_id = newest.thread_id
JOIN content.post AS post
  ON post.route = thread.route AND post.thread_id = thread.thread_id AND post.post_id = thread.first_post_id
WHERE thread.board_id = :board_id::uuid
  AND thread.visibility = 'published' AND thread.availability = 'available'
  AND post.visibility = 'published' AND post.availability = 'available'
ORDER BY newest.created_at DESC, newest.thread_id DESC
LIMIT 1;
