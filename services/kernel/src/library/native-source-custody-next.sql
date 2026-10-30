-- One exact Collection prefix, including foreign/unprovable metadata for truthful pending.
-- Both bounds are index coordinates even in a generic plan; exact capture lookup scans no predecessors.
WITH input AS NOT MATERIALIZED (
 SELECT :route::integer AS route, :collection_id::uuid AS collection_id, :capture_id::nullable(uuid) AS capture_id
)
SELECT c.route,c.capture_id::text AS "captureId",c.collection_id::text AS "collectionId",c.account_id::text AS "accountId",
 c.incarnation,c.generation::text AS generation,c.scope,c.owner_epoch AS "ownerEpoch",
 c.receiving_epoch::text AS "receivingEpoch",c.effect_key AS "effectKey",
 c.output_generation::text AS "outputGeneration",c.publication_transaction_id::text AS "publicationTransactionId",c.publication_position::text AS "publicationPosition",
 s.source_generation::text AS "sourceGeneration"
FROM input JOIN library.native_source_capture c ON c.route=input.route AND c.collection_id=input.collection_id
LEFT JOIN library.collection s ON s.route=c.route AND s.collection_id=c.collection_id
WHERE c.capture_id>=COALESCE(input.capture_id,'00000000-0000-0000-0000-000000000000'::uuid)
  AND c.capture_id<=COALESCE(input.capture_id,'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
ORDER BY c.capture_id LIMIT 1;
