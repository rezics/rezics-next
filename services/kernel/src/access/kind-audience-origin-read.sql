-- An exact reference resolves only in its current committed episode and original lifetime.
WITH input AS MATERIALIZED (SELECT :now_ms::text::bigint AS now_ms)
SELECT original.original_digest AS "originalDigest", original.formula_digest AS "formulaDigest",
       original.source_generation::text AS "sourceGeneration", original.source_capture AS "sourceCapture",
       original.origin_at::text AS "originAt", original.expires_at::text AS "expiresAt",
       original.deadline_at::text AS "deadlineAt", original.cancelled,
       consumer.reference_id AS "referenceId", consumer.enrollment_generation::text AS "enrollmentGeneration"
FROM library.collection_kind_audience_origin AS original
JOIN input ON true
JOIN library.collection_kind_observation AS observation
  ON (observation.route,observation.collection_id,observation.audience)=
     (original.route,original.collection_id,original.audience)
JOIN library.collection AS collection
  ON (collection.route,collection.collection_id,collection.curator_account_id)=
     (original.route,original.collection_id,original.owner_account_id)
LEFT JOIN LATERAL (
  SELECT consumer.reference_id,consumer.enrollment_generation
  FROM library.collection_kind_consent_consumer AS consumer
  WHERE (consumer.route,consumer.owner_account_id,consumer.collection_id,consumer.preparation_id,consumer.origin_id)=
        (original.route,original.owner_account_id,original.collection_id,original.preparation_id,original.origin_id)
    AND NOT consumer.invalidated AND consumer.source_generation=original.source_generation
    AND consumer.source_capture=original.source_capture
  LIMIT 1 FOR SHARE
) AS consumer ON true
WHERE original.route=:route::integer AND original.origin_id=:origin_id::text
  AND original.owner_account_id=:owner_account_id::uuid
  AND original.collection_id=:collection_id::uuid AND original.preparation_id=:preparation_id::uuid
  AND original.audience=:audience::text AND NOT original.cancelled
  AND observation.account_id=original.owner_account_id
  AND observation.generation=original.preparation_id AND observation.source_generation=original.source_generation
  AND observation.capture=original.source_capture
  AND collection.state='active' AND collection.presentation_kind IS NULL
  AND collection.source_generation=original.source_generation
  AND original.expires_at>to_timestamp(input.now_ms / 1000.0)
  AND original.origin_at<=:at::timestamptz
  AND original.deadline_at>input.now_ms
AND NOT EXISTS (
    SELECT 1 FROM library.collection_kind_consent_consumer AS revoked
    WHERE (revoked.route,revoked.owner_account_id,revoked.collection_id,revoked.preparation_id,revoked.origin_id)=
          (original.route,original.owner_account_id,original.collection_id,original.preparation_id,original.origin_id)
      AND revoked.invalidated
  )
LIMIT 1
FOR UPDATE OF original,observation,collection;
