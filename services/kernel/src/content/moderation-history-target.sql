WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :kind::text AS kind, :id::uuid AS id
)
SELECT NULL::uuid AS author_account_id, b.board_id, true AS available
FROM content.board b CROSS JOIN input i
WHERE i.kind = 'board' AND b.route = i.route AND b.board_id = i.id
UNION ALL
SELECT t.author_account_id, t.board_id, t.availability = 'available' AS available
FROM content.thread t CROSS JOIN input i
WHERE i.kind = 'thread' AND t.route = i.route AND t.thread_id = i.id
UNION ALL
SELECT p.author_account_id, t.board_id,
       p.availability = 'available' AND t.availability = 'available' AS available
FROM content.post p JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
CROSS JOIN input i
WHERE i.kind = 'post' AND p.route = i.route AND p.post_id = i.id;
