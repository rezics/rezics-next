SELECT uploader_id, claimed_item_id, claimed_realm_id, erased, collection_pending,
       purpose, container_id, knowledge_publication_generation::text AS knowledge_publication_generation
FROM content.media WHERE route = :route::integer AND media_id = :id::uuid;
