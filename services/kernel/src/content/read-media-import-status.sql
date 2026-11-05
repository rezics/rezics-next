WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route)
SELECT m.media_id, m.container_id, m.uploader_id, m.reservation_request_id,
       m.purpose, m.state, m.byte_count, m.actual_byte_count, m.media_type, m.sha256,
       m.source_url, m.credit, m.provenance, m.erased, m.taken_down, m.collection_pending,
       m.crop, m.focal_x, m.focal_y, m.decision, m.transaction_id, m.created_at::text,
       m.xmin::text = pg_current_xact_id_if_assigned()::text AS inserted_here,
       EXISTS (
         SELECT 1 FROM content.media_variant v CROSS JOIN input
         WHERE v.route = input.route AND v.media_id = m.media_id
         LIMIT 1
       ) AS has_variants
FROM content.media m CROSS JOIN input
WHERE m.route = input.route AND m.media_id = ANY (ARRAY[:media_id::uuid]);
