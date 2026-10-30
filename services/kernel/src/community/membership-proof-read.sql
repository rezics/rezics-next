-- Both keys are native points. A copied proof row without its committed command
-- receipt (or with another source transaction) confers no completion authority.
SELECT p.transaction_id::text AS "transactionId", p.outcome,
       p.publication_transaction_id::text AS "publicationTransactionId"
FROM community.realm_membership_proof p
JOIN core.receipt r ON r.partition_no=(:route::integer >> 4) AND r.principal_kind='account'
 AND r.principal_id=p.principal_id AND r.command_kind=p.command_kind AND r.idempotency_key=p.command_key
 AND r.transaction_id=p.transaction_id
 AND r.response->>'realmId'=p.realm_id::text AND r.response->>'accountId'=p.account_id::text
 AND r.response->>'reservationId'=p.reservation_id::text
 AND (r.response->>'publicationTransactionId') IS NOT DISTINCT FROM p.publication_transaction_id::text
 AND r.response->'transition'->>'generationId'=p.generation_id::text
 AND r.response->'transition'->>'operationId'=p.operation_id
 AND r.response->'transition'->>'outcome'=p.outcome
WHERE p.route=:route::integer AND p.realm_id=:realm_id::uuid AND p.account_id=:account_id::uuid
 AND p.reservation_id=:reservation_id::uuid AND p.generation_id=:generation_id::uuid AND p.operation_id=:operation_id::text;
