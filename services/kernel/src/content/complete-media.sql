WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :media_id::uuid AS media_id, :uploader_id::uuid AS uploader_id,
         :container_id::uuid AS container_id, :reservation_request_id::text AS reservation_request_id,
         :byte_count::bigint AS byte_count, :sha256::text AS sha256, :transaction_id::uuid AS transaction_id
)
UPDATE content.media m
SET state = 'uploaded', actual_byte_count = i.byte_count, sha256 = i.sha256, transaction_id = i.transaction_id
FROM input i
WHERE m.route = i.route AND m.media_id = i.media_id
  AND m.uploader_id = i.uploader_id AND m.container_id = i.container_id
  AND m.reservation_request_id = i.reservation_request_id AND m.byte_count = i.byte_count
  AND (m.declared_sha256 IS NULL OR m.declared_sha256 = i.sha256)
  AND m.purpose IN ('post-image', 'avatar', 'realm-icon', 'realm-banner') AND m.state = 'reserved'
  AND NOT m.erased AND NOT m.collection_pending AND NOT m.taken_down
RETURNING m.media_id;
