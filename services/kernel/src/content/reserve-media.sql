INSERT INTO content.media (
  route, media_id, container_id, uploader_id, reservation_request_id,
  purpose, media_type, byte_count, declared_sha256, state, key, created_at, transaction_id
) VALUES (
  :route::integer, :media_id::uuid, :container_id::uuid, :uploader_id::uuid,
  :reservation_request_id::text, :purpose::text, :media_type::text, :byte_count::bigint,
  :declared_sha256::nullable(text), 'reserved', :key::text, :at::timestamptz, :transaction_id::uuid
);
