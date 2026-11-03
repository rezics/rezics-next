SELECT thread.board_id, thread.first_post_id,
       post.post_id, post.author_account_id,
       post.security_revision::text AS security_revision,
       post.visibility AS post_visibility,
       post.availability AS post_availability,
       post.head_availability, post.author_erased,
       to_char(thread.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       to_char(post.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS item_created_at
FROM content.thread AS thread
LEFT JOIN content.post AS post
  ON post.route = thread.route AND post.thread_id = thread.thread_id AND post.post_id = :post_id::uuid
WHERE thread.route = :route::integer AND thread.thread_id = :thread_id::uuid;
