UPDATE content.media
SET state = 'rejected', decision = :decision::text, collection_pending = true,
    transaction_id = :transaction_id::uuid
WHERE route = :route::integer AND media_id = :media_id::uuid
  AND purpose = 'cover' AND state = 'reserved'
  AND NOT erased AND NOT collection_pending AND NOT taken_down
RETURNING media_id;
