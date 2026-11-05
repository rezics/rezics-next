SELECT container_id, uploader_id, purpose, state, key, erased, collection_pending, taken_down,
       source_url, credit, provenance, crop, focal_x, focal_y
FROM content.media
WHERE route = :route::integer AND media_id = :media_id::uuid
FOR UPDATE;
