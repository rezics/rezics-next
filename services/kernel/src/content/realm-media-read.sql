-- One exact object. The slot constraint bounds the derivative subquery to twelve rows.
SELECT m.media_id, m.container_id, m.uploader_id, m.purpose, m.state,
       m.claimed_realm_id, m.claimed_at::text, m.erased, m.collection_pending,
       m.taken_down, m.security_revision::text, m.sha256,
       encode(m.thumbhash, 'base64') AS thumbhash, m.average_color, m.focal_x, m.focal_y,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'format', v.format, 'width', v.width, 'height', v.height,
           'key', v.key, 'sha256', v.sha256, 'mediaType', v.media_type, 'byteCount', v.byte_count
         ) ORDER BY v.format, v.width)::text
         FROM content.media_variant v
         WHERE v.route = :route::integer AND v.media_id = m.media_id
       ), '[]') AS variants_json
FROM content.media m
WHERE m.route = :route::integer AND m.media_id = :media_id::uuid
LIMIT 1;
