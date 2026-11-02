-- One bounded exact owner episode. More than one origin for the same preparation is ambiguous.
SELECT consumer.reference_id AS "referenceId",
       consumer.origin_id AS "originId",
       consumer.source_generation::text AS "sourceGeneration",
       consumer.capture_generation::text AS "captureGeneration",
       consumer.source_capture AS "sourceCapture",
       consumer.enrollment_generation::text AS "enrollmentGeneration",
       consumer.catalogue_root AS "catalogueRoot",
       consumer.restore_generation::text AS "restoreGeneration",
       collection.source_generation::text AS "currentSourceGeneration",
       collection.state AS "collectionState"
FROM library.collection_kind_consent_consumer AS consumer
JOIN library.collection AS collection
  ON (collection.route,collection.collection_id,collection.curator_account_id)=
     (consumer.route,consumer.collection_id,consumer.owner_account_id)
JOIN library.collection_kind_audience_origin AS original
  ON (original.route,original.origin_id,original.owner_account_id,original.collection_id,original.preparation_id)=
     (consumer.route,consumer.origin_id,consumer.owner_account_id,consumer.collection_id,consumer.preparation_id)
JOIN library.collection_kind_observation AS observation
  ON (observation.route,observation.collection_id,observation.audience)=
     (original.route,original.collection_id,original.audience)
WHERE consumer.route=:route::integer
  AND consumer.owner_account_id=:owner_account_id::uuid
  AND consumer.collection_id=:collection_id::uuid
  AND consumer.preparation_id=:preparation_id::uuid
  AND consumer.invalidated=false AND NOT original.cancelled
  AND original.source_generation=consumer.source_generation
  AND original.source_capture=consumer.source_capture
  AND original.deadline_at=:deadline_at::text::bigint
  AND original.expires_at>clock_timestamp()
  AND observation.generation=consumer.preparation_id
  AND observation.account_id=consumer.owner_account_id
  AND observation.source_generation=consumer.source_generation
  AND observation.capture=consumer.source_capture
  AND collection.state='active'
  AND collection.source_generation=consumer.source_generation
ORDER BY consumer.reference_id
LIMIT 2
FOR UPDATE OF consumer,collection,original,observation;
