SELECT original.audience, original.original_digest AS "originalDigest", original.formula_digest AS "formulaDigest",
       observation.version::text AS version, consumer.reference_id AS "referenceId",
       consumer.enrollment_generation::text AS "enrollmentGeneration", consumer.restore_generation::text AS "restoreGeneration",
       consumer.catalogue_root AS "catalogueRoot", consumer.source_capture AS capture
FROM library.collection_kind_audience_origin original
JOIN library.collection_kind_observation observation
  ON (observation.route,observation.collection_id,observation.audience)=
     (original.route,original.collection_id,original.audience)
JOIN library.collection_kind_consent_consumer consumer
  ON (consumer.route,consumer.reference_id)=(original.route,:reference_id::text)
WHERE original.route=:route::integer AND original.origin_id=:origin_id::text
  AND original.preparation_id=:preparation_id::uuid
  AND observation.generation=original.preparation_id AND NOT observation.complete
  AND NOT original.cancelled AND NOT consumer.invalidated
  AND consumer.preparation_id=original.preparation_id AND consumer.origin_id=original.origin_id
  AND consumer.source_capture=original.source_capture AND consumer.source_generation=original.source_generation
  AND original.expires_at>clock_timestamp() AND original.deadline_at>:now_ms::text::bigint
LIMIT 1 FOR UPDATE OF original,observation,consumer;
