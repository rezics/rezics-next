-- No variant enumeration: this is one exact object and one exact processed slot.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :media_id::uuid AS media_id,
         :format::text AS format, :width::integer AS width
)
SELECT m.media_id, m.container_id, m.claimed_item_id, m.uploader_id, m.purpose, m.state, m.claimed_at::text,
       m.key, m.sha256, m.media_type, m.actual_byte_count, m.erased, m.collection_pending,
       m.taken_down, m.security_revision::text, m.provenance,
       COALESCE(m.crop[3], m.width) AS width, COALESCE(m.crop[4], m.height) AS height,
       encode(m.thumbhash, 'base64') AS thumbhash, m.average_color, m.focal_x, m.focal_y, m.credit,
       v.key AS variant_key, v.sha256 AS variant_sha256, v.media_type AS variant_media_type,
       v.byte_count AS variant_byte_count, v.format AS variant_format,
       v.width AS variant_width, v.height AS variant_height
FROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id
LEFT JOIN content.media_variant v
  ON v.route = i.route AND v.media_id = m.media_id
  AND v.format = i.format AND v.width = i.width;
