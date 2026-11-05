SELECT m.container_id, m.key, m.actual_byte_count, m.sha256, m.state,
       m.erased, m.collection_pending, m.crop, m.focal_x, m.focal_y,
       v.format, v.width, v.height, v.media_type, v.byte_count,
       v.sha256 AS variant_sha256, v.key AS variant_key
FROM content.media AS m
LEFT JOIN content.media_variant AS v ON v.route = m.route AND v.media_id = m.media_id
WHERE m.route = :route::integer AND m.media_id = :media_id::uuid
ORDER BY v.format, v.width
FOR UPDATE OF m;
