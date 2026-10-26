-- Only the actual resource supplies identity and lifecycle. Each branch is an
-- exact route + ID probe; no author, revision, descendant or variant expansion.
WITH input AS NOT MATERIALIZED (
  SELECT :kind::text AS kind, :route::integer AS route, :id::uuid AS id
)
SELECT board_id AS id, NULL::uuid AS container_id, false AS collection_pending, NULL::uuid AS board_id
FROM content.board t CROSS JOIN input i WHERE i.kind = 'board' AND t.route = i.route AND board_id = i.id
UNION ALL
SELECT thread_id, NULL::uuid, false, t.board_id
FROM content.thread t CROSS JOIN input i WHERE i.kind = 'thread' AND t.route = i.route AND thread_id = i.id
UNION ALL
-- Posts and their threads share a route, enforced by content.post's constraints.
SELECT post_id, thread_id, false,
       (SELECT th.board_id FROM content.thread th WHERE th.route = i.route AND th.thread_id = t.thread_id)
FROM content.post t CROSS JOIN input i WHERE i.kind = 'post' AND t.route = i.route AND post_id = i.id
UNION ALL
SELECT media_id, container_id, collection_pending, NULL::uuid
FROM content.media t CROSS JOIN input i WHERE i.kind = 'media' AND t.route = i.route AND media_id = i.id;
