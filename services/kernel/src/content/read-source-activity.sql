SELECT thread.board_id,
       to_char(thread.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       to_char(post.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS item_created_at
FROM content.thread AS thread
LEFT JOIN content.post AS post
  ON post.route = thread.route AND post.thread_id = thread.thread_id AND post.post_id = :post_id::uuid
WHERE thread.route = :route::integer AND thread.thread_id = :thread_id::uuid;
