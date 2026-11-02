WITH supplied AS MATERIALIZED (
  SELECT :route::integer AS route,
         :reference_id::text AS reference_id,
         :owner_account_id::uuid AS owner_account_id,
         :collection_id::uuid AS collection_id,
         :preparation_id::uuid AS preparation_id,
         :origin_id::text AS origin_id,
         :transition_id::text AS transition_id,
         :receipt_reference::text AS receipt_reference
), locked AS MATERIALIZED (
  SELECT consumer.route, consumer.reference_id, consumer.owner_account_id,
         consumer.collection_id, consumer.preparation_id, consumer.origin_id,
         consumer.enrollment_generation, consumer.restore_generation,
         consumer.last_transition_id, consumer.invalidated
  FROM library.collection_kind_consent_consumer AS consumer
  JOIN supplied USING (route, reference_id, owner_account_id, collection_id, preparation_id, origin_id)
  FOR UPDATE OF consumer
), existing AS MATERIALIZED (
  SELECT transition.transition_id, transition.enrollment_generation
  FROM library.collection_kind_consent_transition AS transition
  JOIN supplied USING (route, reference_id)
  WHERE transition.transition_id=supplied.transition_id
), prior AS MATERIALIZED (
  SELECT transition.receipt_reference, transition.enrollment_generation
  FROM library.collection_kind_consent_transition AS transition
  JOIN locked USING (route, reference_id, enrollment_generation)
  JOIN supplied USING (route, reference_id)
  WHERE transition.transition_id=supplied.transition_id
    AND transition.status='committed'
    AND locked.invalidated
    AND locked.last_transition_id=transition.transition_id
    AND locked.restore_generation=transition.restore_generation
), fenced AS (
  UPDATE library.collection_kind_consent_consumer AS consumer
  SET invalidated=true, last_transition_id=supplied.transition_id,
      restore_generation=consumer.restore_generation+1
  FROM locked, supplied
  WHERE consumer.route=locked.route AND consumer.reference_id=locked.reference_id
    AND consumer.enrollment_generation=locked.enrollment_generation
    AND NOT EXISTS (SELECT 1 FROM existing)
  RETURNING consumer.route, consumer.reference_id, consumer.enrollment_generation,
            consumer.restore_generation::text AS restore_generation
), inserted AS (
  INSERT INTO library.collection_kind_consent_transition
    (route,reference_id,transition_id,enrollment_generation,restore_generation,receipt_reference,status)
  SELECT fenced.route, fenced.reference_id, supplied.transition_id,
         fenced.enrollment_generation, fenced.restore_generation::bigint,
         supplied.receipt_reference, 'committed'
  FROM fenced CROSS JOIN supplied
  ON CONFLICT (route,reference_id,transition_id) DO NOTHING
  RETURNING receipt_reference, enrollment_generation
), result AS (
  SELECT prior.receipt_reference
  FROM prior JOIN locked USING (enrollment_generation)
  UNION ALL
  SELECT inserted.receipt_reference
  FROM inserted JOIN locked USING (enrollment_generation)
)
SELECT 'committed'::text AS status, result.receipt_reference AS "receiptReference"
FROM result
LIMIT 1;
