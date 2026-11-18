SELECT route,collection_id AS "collectionId",account_id AS "curatorAccountId",
       generation::text AS "sourceGeneration"
FROM library.logical_everything_source
WHERE route=:route AND collection_id=:collection_id;
