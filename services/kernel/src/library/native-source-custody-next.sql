-- One exact Collection prefix, including foreign/unprovable metadata for truthful pending.
SELECT c.route,c.capture_id::text AS "captureId",c.collection_id::text AS "collectionId",c.account_id::text AS "accountId",
 c.incarnation,c.generation::text AS generation,c.scope,c.owner_epoch AS "ownerEpoch",
 c.receiving_epoch::text AS "receivingEpoch",c.effect_key AS "effectKey",
 s.source_generation::text AS "sourceGeneration"
FROM library.native_source_capture c LEFT JOIN library.collection s
 ON s.route=c.route AND s.collection_id=c.collection_id
WHERE c.route=:route AND c.collection_id=:collection_id
AND (:capture_id::nullable(uuid) IS NULL OR c.capture_id=:capture_id)
ORDER BY c.capture_id LIMIT 1;
