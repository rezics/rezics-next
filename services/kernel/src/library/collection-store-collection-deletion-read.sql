SELECT revision, deleted_at::text AS "deletedAt", purge_after::text AS "purgeAfter"
FROM library.collection
WHERE route = :route AND collection_id = :id;
