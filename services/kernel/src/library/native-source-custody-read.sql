SELECT route,capture_id AS "captureId",collection_id AS "collectionId",account_id AS "accountId",
incarnation,generation::text AS generation,scope,owner_epoch AS "ownerEpoch",receiving_epoch::text AS "receivingEpoch",effect_key AS "effectKey",
output_generation::text AS "outputGeneration",publication_transaction_id::text AS "publicationTransactionId",publication_position::text AS "publicationPosition",
collection_fence::text AS "collectionFence",account_fence::text AS "accountFence",
driver,after_key AS after,tie,session_id::text AS "sessionId",scanned::text AS scanned,version,complete FROM library.native_source_capture
WHERE route=:route AND capture_id=:capture_id FOR UPDATE;
