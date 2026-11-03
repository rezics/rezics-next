SELECT thread.route, thread.thread_id, thread.first_post_id,
       thread.security_revision::text AS thread_security_revision,
       thread.board_id, board.security_revision::text AS board_security_revision
FROM content.thread AS thread
JOIN content.board AS board
  ON board.route = thread.route AND board.board_id = thread.board_id
WHERE thread.route BETWEEN :first_route::integer AND :last_route::integer
  AND (thread.route, thread.thread_id) >
      (COALESCE(:after_route::nullable(integer), :first_route::integer - 1),
       COALESCE(:after_thread_id::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid))
ORDER BY thread.route, thread.thread_id
LIMIT :limit::integer;
