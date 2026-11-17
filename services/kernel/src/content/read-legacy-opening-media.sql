SELECT media_id::text, reservation_request_id, media_type, byte_count::text, declared_sha256
FROM content.media
WHERE route = :route::integer AND media_id = ANY(:media_ids::uuid[])
  AND container_id = :container_id::uuid AND uploader_id = :uploader_id::uuid
  AND purpose = 'post-image' AND state = 'available' AND reservation_board_id IS NULL
  AND NOT erased AND NOT collection_pending AND NOT taken_down;
