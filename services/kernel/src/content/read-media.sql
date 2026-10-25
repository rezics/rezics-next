-- Each branch is a point probe at an explicit route and ID. Container walks are
-- bounded in the adapter; a board in another route is a separate point probe.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :id::uuid AS id, :kind::text AS kind
)
SELECT m.media_id, m.route, m.container_id, m.uploader_id, m.reservation_request_id,
       m.purpose, m.media_type, m.byte_count, m.declared_sha256, m.sha256, m.state,
       m.claimed_at::text, m.created_at::text, m.transaction_id, m.key,
       m.erased, m.collection_pending, m.decision,
       m.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'format', v.format, 'width', v.width, 'height', v.height, 'mediaType', v.media_type,
           'byteCount', v.byte_count, 'sha256', v.sha256, 'key', v.key
         ) ORDER BY v.format, v.width)::text
         FROM content.media_variant v
         WHERE v.route = i.route AND v.media_id = m.media_id
       ), '[]') AS variants_json,
       a.kind, a.id, a.parent_id, a.thread_id, a.board_id,
       a.visibility, a.security_revision, a.availability
FROM input i
LEFT JOIN content.media m
  ON i.kind = 'media' AND m.route = i.route AND m.media_id = i.id
LEFT JOIN LATERAL (
  SELECT 'thread'::text AS kind, t.thread_id AS id, NULL::uuid AS parent_id,
         t.thread_id, t.board_id, t.visibility, t.security_revision::text,
         'available'::text AS availability
  FROM content.thread t
  WHERE i.kind IN ('container', 'thread') AND t.route = i.route AND t.thread_id = i.id
  UNION ALL
  SELECT 'post', p.post_id, p.reply_to_post_id, p.thread_id, NULL::uuid,
         p.visibility, p.security_revision::text, r.availability
  FROM content.post p
  JOIN content.revision r ON r.route = i.route AND r.thread_id = p.thread_id
    AND r.post_id = p.post_id AND r.revision_id = p.head_revision_id
  WHERE i.kind IN ('container', 'post') AND p.route = i.route AND p.post_id = i.id
  UNION ALL
  SELECT 'board', b.board_id, NULL::uuid, NULL::uuid, NULL::uuid,
         b.visibility, b.security_revision::text, 'available'
  FROM content.board b
  WHERE i.kind = 'board' AND b.route = i.route AND b.board_id = i.id
) a ON true
WHERE m.media_id IS NOT NULL OR a.id IS NOT NULL;
