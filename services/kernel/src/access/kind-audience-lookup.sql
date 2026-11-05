-- Native lookup only: an enrollment is necessary, never a complete audience proof.
SELECT consumer.origin_id AS "originId", consumer.reference_id AS "referenceId",
       consumer.capture_generation::text AS "captureGeneration",
       consumer.enrollment_generation::text AS "enrollmentGeneration",
       consumer.catalogue_root AS "catalogueRoot"
FROM library.collection_kind_consent_consumer AS consumer
JOIN library.collection AS collection
  ON (collection.route,collection.collection_id,collection.curator_account_id)=
     (consumer.route,consumer.collection_id,consumer.owner_account_id)
WHERE consumer.route=:route::integer
  AND consumer.owner_account_id=:owner_account_id::uuid
  AND consumer.collection_id=:collection_id::uuid
  AND consumer.preparation_id=:preparation_id::uuid
  AND NOT consumer.invalidated
  AND collection.state='active'
  AND collection.source_generation=consumer.source_generation
ORDER BY consumer.reference_id
LIMIT 2;
