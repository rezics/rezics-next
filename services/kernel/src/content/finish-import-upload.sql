WITH input AS NOT MATERIALIZED (
  SELECT :byte_count::bigint AS byte_count
)
UPDATE content.media AS m
SET state = 'uploaded', byte_count = input.byte_count, actual_byte_count = input.byte_count,
    media_type = :media_type::text, sha256 = :sha256::text, transaction_id = :transaction_id::uuid
FROM input
WHERE m.route = :route::integer AND m.media_id = :media_id::uuid
  AND m.purpose = 'cover' AND m.state = 'reserved'
  AND NOT m.erased AND NOT m.collection_pending AND NOT m.taken_down
RETURNING m.media_id;
