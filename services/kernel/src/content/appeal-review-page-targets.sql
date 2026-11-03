WITH requested AS (
  SELECT input.kind, input.id
  FROM unnest(:target_kinds::text[], :target_ids::uuid[]) AS input(kind, id)
)
SELECT requested.kind,
       requested.id::text AS target_id,
       board.board_id::text AS board_id,
       COALESCE(thread.thread_id, post_thread.thread_id)::text AS thread_id,
       CASE requested.kind
         WHEN 'board' THEN board.board_id IS NOT NULL
         WHEN 'thread' THEN thread.thread_id IS NOT NULL
         WHEN 'post' THEN post.post_id IS NOT NULL AND post_thread.thread_id IS NOT NULL
         ELSE false
       END AS present
FROM requested
LEFT JOIN content.board board
  ON requested.kind = 'board' AND board.route = :route::integer AND board.board_id = requested.id
LEFT JOIN content.thread thread
  ON requested.kind = 'thread' AND thread.route = :route::integer AND thread.thread_id = requested.id
LEFT JOIN content.post post
  ON requested.kind = 'post' AND post.route = :route::integer AND post.post_id = requested.id
LEFT JOIN content.thread post_thread
  ON requested.kind = 'post' AND post_thread.route = post.route AND post_thread.thread_id = post.thread_id;
