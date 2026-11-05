SELECT revision, deletion_id AS "deletionId", state = 'deleted' AS deleted,
       coalesce(purge_after <= :time::timestamptz, true) AS expired
FROM library.collection
WHERE route = :route::integer AND collection_id = :id::uuid;
