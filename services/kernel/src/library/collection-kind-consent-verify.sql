SELECT transition.receipt_reference AS "receiptReference"
FROM library.collection_kind_consent_transition AS transition
JOIN library.collection_kind_consent_consumer AS consumer
  ON consumer.route=transition.route AND consumer.reference_id=transition.reference_id
WHERE transition.route=:route::integer AND transition.reference_id=:reference_id::text
  AND transition.transition_id=:transition_id::text
  AND transition.receipt_reference=:receipt_reference::text
  AND transition.status='committed'
  AND consumer.owner_account_id=:owner_account_id::uuid
  AND consumer.collection_id=:collection_id::uuid
  AND consumer.preparation_id=:preparation_id::uuid
  AND consumer.origin_id=:origin_id::text
  AND consumer.enrollment_generation=transition.enrollment_generation
  AND consumer.invalidated
  AND consumer.last_transition_id=transition.transition_id
  AND consumer.restore_generation=transition.restore_generation
LIMIT 1
FOR UPDATE OF consumer;
