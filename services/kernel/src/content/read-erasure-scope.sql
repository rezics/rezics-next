-- Only the actual resource supplies identity and lifecycle. Each branch is an
-- exact route + ID probe; no author, revision, descendant or variant expansion.
WITH input AS NOT MATERIALIZED (
  SELECT :kind::text AS kind, :route::integer AS route, :id::uuid AS id,
         :resolve_realm::boolean AS resolve_realm
)
SELECT board_id AS id, NULL::uuid AS container_id, false AS collection_pending, NULL::uuid AS realm_id
FROM content.board t CROSS JOIN input i WHERE i.kind = 'board' AND t.route = i.route AND board_id = i.id
UNION ALL
SELECT thread_id, NULL::uuid, false,
       CASE WHEN i.resolve_realm THEN (
         SELECT b.realm_id FROM content.board b
         WHERE b.route = get_byte(uuid_send(t.board_id), 10) * 256 + get_byte(uuid_send(t.board_id), 11)
           AND b.board_id = t.board_id
       ) ELSE NULL::uuid END
FROM content.thread t CROSS JOIN input i WHERE i.kind = 'thread' AND t.route = i.route AND thread_id = i.id
UNION ALL
SELECT post_id, thread_id, false,
       CASE WHEN i.resolve_realm THEN (
         SELECT b.realm_id
         FROM content.thread th JOIN content.board b
           ON b.route = get_byte(uuid_send(th.board_id), 10) * 256 + get_byte(uuid_send(th.board_id), 11)
          AND b.board_id = th.board_id
         WHERE th.route = t.route AND th.thread_id = t.thread_id
       ) ELSE NULL::uuid END
FROM content.post t CROSS JOIN input i WHERE i.kind = 'post' AND t.route = i.route AND post_id = i.id
UNION ALL
SELECT media_id, container_id, collection_pending, NULL::uuid
FROM content.media t CROSS JOIN input i WHERE i.kind = 'media' AND t.route = i.route AND media_id = i.id;
