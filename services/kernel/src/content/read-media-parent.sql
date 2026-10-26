WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :kind::text AS kind
)
SELECT 'thread'::text AS kind, t.thread_id AS id, NULL::uuid AS parent_id,
  t.thread_id, t.board_id, NULL::uuid AS realm_id, NULL::text AS purpose,
  t.visibility, t.security_revision::text, 'available'::text AS availability
  FROM input i
  JOIN content.thread t ON t.route = i.route AND t.thread_id = i.id
  WHERE i.kind IN ('container', 'thread')
  UNION ALL
  SELECT 'post', p.post_id, p.reply_to_post_id, p.thread_id, NULL::uuid,
  NULL::uuid, NULL::text, p.visibility, p.security_revision::text,
  CASE WHEN p.availability = 'erased' THEN 'erased' ELSE r.availability END
  FROM input i
  JOIN content.post p ON p.route = i.route AND p.post_id = i.id
  JOIN content.revision r ON r.route = i.route AND r.thread_id = p.thread_id
    AND r.post_id = p.post_id AND r.revision_id = p.head_revision_id
  WHERE i.kind IN ('container', 'post');
