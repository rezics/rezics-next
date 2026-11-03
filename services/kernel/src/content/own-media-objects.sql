-- One exact selected media home, one actor, and no more than twelve stored derivatives per object.
WITH input AS MATERIALIZED (
  SELECT selected.route, selected.media_id
  FROM unnest(:routes::integer[], :ids::uuid[]) AS selected(route, media_id)
)
SELECT m.media_id::text AS id, COALESCE(m.claimed_item_id, m.container_id)::text AS context_id,
       m.purpose, m.state, m.media_type,
       m.byte_count, m.actual_byte_count, m.created_at::text AS created_at,
       m.claimed_at::text AS claimed_at, m.erased, m.collection_pending, m.taken_down,
       m.claimed_realm_id::text AS claimed_realm_id,
       CASE
         WHEN m.purpose = 'post-image' AND p.post_id IS NOT NULL THEN 'post'
         WHEN m.purpose = 'post-image' AND t.thread_id IS NOT NULL THEN 'thread'
         WHEN m.purpose IN ('realm-icon', 'realm-banner') THEN 'realm'
         WHEN m.purpose = 'avatar' AND m.container_id = m.uploader_id THEN 'account'
         ELSE NULL
       END AS container_kind,
       CASE
         WHEN p.visibility = 'taken_down' OR t.visibility = 'taken_down' THEN 'taken_down'
         ELSE COALESCE(p.visibility, t.visibility)
       END AS container_visibility,
       CASE
         WHEN p.post_id IS NOT NULL AND p.availability = 'erased' THEN 'erased'
         WHEN p.post_id IS NOT NULL THEN r.availability
         WHEN t.thread_id IS NOT NULL THEN 'available'
         ELSE NULL
       END AS container_availability,
       COALESCE(p.thread_id, t.thread_id)::text AS thread_id,
       COALESCE(variant_list.items, '[]'::jsonb)::text AS variants_json
FROM input i
CROSS JOIN LATERAL (
  SELECT media.route, media.media_id, media.container_id, media.uploader_id,
         media.purpose, media.state, media.media_type, media.byte_count,
         media.actual_byte_count, media.created_at, media.claimed_at, media.erased,
         media.collection_pending, media.taken_down, media.claimed_realm_id,
         media.claimed_item_id
  FROM content.media AS media
  WHERE media.route = i.route AND media.media_id = i.media_id
    AND media.uploader_id = :uploader_id::uuid
) AS m
LEFT JOIN content.post AS p
  ON m.purpose = 'post-image'
 AND p.route = m.route
 AND p.post_id = COALESCE(m.claimed_item_id, m.container_id)
LEFT JOIN content.revision AS r
  ON r.route = p.route AND r.thread_id = p.thread_id
 AND r.post_id = p.post_id AND r.revision_id = p.head_revision_id
LEFT JOIN content.thread AS t
  ON m.purpose = 'post-image'
 AND t.route = m.route
 AND t.thread_id = CASE WHEN m.claimed_item_id IS NULL THEN COALESCE(p.thread_id, m.container_id) ELSE p.thread_id END
LEFT JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
           'format', selected.format,
           'width', selected.width,
           'height', selected.height,
           'mediaType', selected.media_type,
           'byteCount', selected.byte_count
         ) ORDER BY selected.format, selected.width) AS items
  FROM (
    SELECT v.format, v.width, v.height, v.media_type, v.byte_count
    FROM content.media_variant AS v
    WHERE v.route = m.route AND v.media_id = m.media_id
    ORDER BY v.format, v.width
    LIMIT 12
  ) AS selected
) AS variant_list ON true
ORDER BY m.media_id;
