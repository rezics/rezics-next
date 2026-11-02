SELECT route,reference_id,owner_account_id AS "ownerAccountId",
       collection_id AS "collectionId",preparation_id AS "preparationId",origin_id AS "originId",
       source_generation::text AS "sourceGeneration",capture_generation AS "captureGeneration",
       source_capture AS "sourceCapture",enrollment_generation AS "enrollmentGeneration",
       restore_generation::text AS "restoreGeneration",invalidated,catalogue_root AS "catalogueRoot"
FROM library.collection_kind_consent_consumer
WHERE route=:route::integer AND reference_id=:reference_id::text
FOR UPDATE;
