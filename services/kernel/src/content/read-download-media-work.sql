-- Work-only wire projection. Optional display fields follow the generator's
-- <=32-byte ThumbHash and #rrggbb colour format, including historical rows.
-- Required credit/provenance are returned whole or the point is unavailable;
-- these are the import envelope's 8192/65536 UTF-8 limits, not compressed sizes.
-- A captured null uses a zero limit: a changed nonnull value then fails closed
-- before projection, rather than borrowing its size from the captured row.
WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :media_id::uuid AS media_id,
         :format::text AS format, :width::integer AS width
)
SELECT m.media_id, m.container_id, m.claimed_item_id, m.uploader_id, m.purpose, m.state, m.claimed_at::text,
       m.key, m.sha256, m.media_type, m.actual_byte_count, m.erased, m.collection_pending,
       m.taken_down, m.security_revision::text, m.provenance,
       COALESCE(m.crop[3], m.width) AS width, COALESCE(m.crop[4], m.height) AS height,
       CASE WHEN octet_length(m.thumbhash) <= 32 THEN encode(m.thumbhash, 'base64') END AS thumbhash,
       CASE WHEN octet_length(m.average_color) = 7 AND m.average_color ~ '^#[0-9a-f]{6}$'
            THEN m.average_color END AS average_color, m.focal_x, m.focal_y, m.credit,
       v.key AS variant_key, v.sha256 AS variant_sha256, v.media_type AS variant_media_type,
       v.byte_count AS variant_byte_count, v.format AS variant_format,
       v.width AS variant_width, v.height AS variant_height
FROM input i JOIN content.media m ON m.route = i.route AND m.media_id = i.media_id
LEFT JOIN content.media_variant v
  ON v.route = i.route AND v.media_id = m.media_id
  AND v.format = i.format AND v.width = i.width
WHERE (m.credit IS NULL OR octet_length(convert_to(m.credit::text, 'UTF8')) <= :credit_bytes::integer)
  AND (m.provenance IS NULL OR octet_length(convert_to(m.provenance::text, 'UTF8')) <= :provenance_bytes::integer)
  AND (m.sha256 IS NULL OR (octet_length(m.sha256) = 64 AND m.sha256 ~ '^[0-9a-f]{64}$'));
