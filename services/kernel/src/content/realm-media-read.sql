-- One exact object. The slot constraint bounds the derivative subquery to twelve rows.
-- Bound optional historical metadata before encoding or materializing it. Realm
-- images do not have the cover-only display-metadata admission constraint.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :media_id::uuid AS media_id
)
SELECT m.media_id, m.container_id, m.uploader_id, m.purpose, m.state,
       m.claimed_realm_id, m.claimed_at::text, m.erased, m.collection_pending,
       m.taken_down, m.security_revision::text, m.sha256,
       CASE WHEN octet_length(m.thumbhash) <= 32 THEN encode(m.thumbhash, 'base64') END AS thumbhash,
       CASE WHEN octet_length(m.average_color) = 7 THEN
         CASE WHEN m.average_color ~* '^#[0-9a-f]{6}$' THEN m.average_color END
       END AS average_color, m.focal_x, m.focal_y,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'format', v.format, 'width', v.width, 'height', v.height,
           'key', v.key, 'sha256', v.sha256, 'mediaType', v.media_type, 'byteCount', v.byte_count
         ) ORDER BY v.format, v.width)::text
         FROM content.media_variant v
         WHERE v.route = i.route AND v.media_id = m.media_id
       ), '[]') AS variants_json
FROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id
LIMIT 1;
