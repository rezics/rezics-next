-- Exact native target and its original qualifying source. Replies never acquire a source.
WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :kind::text AS kind, :id::uuid AS id)
SELECT b.security_revision::text AS native_version, '0'::text AS source_version,
       NULL::uuid AS thread_id, b.board_id, b.realm_id, NULL::uuid AS space_id,
       NULL::text AS realm_epoch, b.visibility
FROM content.board b CROSS JOIN input i
WHERE i.kind = 'board' AND b.route = i.route AND b.board_id = i.id AND b.realm_id IS NOT NULL
UNION ALL
SELECT t.security_revision::text, c.source_version::text, c.thread_id, c.board_id,
       c.realm_id, c.space_id, c.realm_epoch::text, t.visibility
FROM content.thread t CROSS JOIN input i
JOIN content.realm_discovery_contribution c ON c.route = i.route AND c.thread_id = i.id
WHERE i.kind = 'thread' AND t.route = i.route AND t.thread_id = i.id
UNION ALL
SELECT p.security_revision::text, c.source_version::text, c.thread_id, c.board_id,
       c.realm_id, c.space_id, c.realm_epoch::text, p.visibility
FROM content.post p CROSS JOIN input i
JOIN content.thread t ON t.route = i.route AND t.first_post_id = i.id AND t.thread_id = p.thread_id
JOIN content.realm_discovery_contribution c ON c.route = i.route AND c.thread_id = t.thread_id
WHERE i.kind = 'post' AND p.route = i.route AND p.post_id = i.id;
