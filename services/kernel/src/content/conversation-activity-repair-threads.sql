WITH input AS (
  SELECT :first_route::integer AS first_route,
         :last_route::integer AS last_route,
         :after_route::nullable(integer) AS after_route,
         :after_thread_id::nullable(uuid) AS after_thread_id
)
SELECT thread.route, thread.thread_id, thread.first_post_id,
       thread.security_revision::text AS thread_security_revision,
       thread.board_id, board.security_revision::text AS board_security_revision
FROM content.thread AS thread
JOIN content.board AS board
  ON board.route = thread.route AND board.board_id = thread.board_id
JOIN input ON true
WHERE thread.route BETWEEN input.first_route AND input.last_route
  AND (thread.route, thread.thread_id) >
      (COALESCE(input.after_route, input.first_route - 1),
       COALESCE(input.after_thread_id, '00000000-0000-0000-0000-000000000000'::uuid))
ORDER BY thread.route, thread.thread_id
LIMIT :limit::integer;
