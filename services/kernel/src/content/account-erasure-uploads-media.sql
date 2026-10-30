SELECT uploader_id, claimed_item_id, claimed_realm_id, erased, collection_pending
FROM content.media WHERE route = :route::integer AND media_id = :id::uuid;
