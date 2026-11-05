INSERT INTO content.media (
  route, media_id, container_id, uploader_id, reservation_request_id,
  purpose, media_type, byte_count, actual_byte_count, sha256, declared_sha256,
  state, key, source_url, credit, provenance, crop, focal_x, focal_y, created_at, transaction_id
) VALUES (
  :route::integer, :media_id::uuid, :container_id::uuid, :uploader_id::uuid,
  :reservation_request_id::text, 'cover', NULL, NULL, NULL, NULL, NULL,
  'reserved', :key::text, :source_url::text, :credit::jsonb, :provenance::jsonb,
  :crop::nullable(integer[]), :focal_x::nullable(real), :focal_y::nullable(real),
  :at::timestamptz, :transaction_id::uuid
)
RETURNING media_id;
