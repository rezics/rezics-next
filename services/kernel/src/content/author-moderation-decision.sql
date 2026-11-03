WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :target_kind::text AS kind, :target_id::uuid AS id
)
SELECT t.author_account_id, t.thread_id, NULL::uuid AS post_id, t.board_id
FROM content.thread t CROSS JOIN input i
WHERE i.kind = 'thread' AND t.route = i.route AND t.thread_id = i.id
UNION ALL
SELECT p.author_account_id, p.thread_id, p.post_id, t.board_id
FROM content.post p JOIN content.thread t ON t.route = p.route AND t.thread_id = p.thread_id
CROSS JOIN input i
WHERE i.kind = 'post' AND p.route = i.route AND p.post_id = i.id
UNION ALL
SELECT NULL::uuid AS author_account_id, NULL::uuid AS thread_id, NULL::uuid AS post_id, b.board_id
FROM content.board b CROSS JOIN input i
WHERE i.kind = 'board' AND b.route = i.route AND b.board_id = i.id;
