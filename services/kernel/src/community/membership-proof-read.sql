-- Both keys are native points. A copied proof row without its committed command
-- receipt (or with another source transaction) confers no completion authority.
WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :account_id::uuid AS account_id, :reservation_id::uuid AS reservation_id, :generation_id::uuid AS generation_id, :operation_id::text AS operation_id)
SELECT p.transaction_id::text AS "transactionId", p.outcome,
       p.publication_transaction_id::text AS "publicationTransactionId"
FROM community.realm_membership_proof p
JOIN core.receipt r ON r.partition_no=((SELECT route FROM input) >> 4) AND r.principal_kind='account'
 AND r.principal_id=p.principal_id AND r.command_kind=p.command_kind AND r.idempotency_key=p.command_key
 AND r.transaction_id=p.transaction_id
 AND r.response->>'realmId'=p.realm_id::text AND r.response->>'accountId'=p.account_id::text
 AND r.response->>'reservationId'=p.reservation_id::text
 AND (r.response->>'publicationTransactionId') IS NOT DISTINCT FROM p.publication_transaction_id::text
 AND r.response->'transition'->>'generationId'=p.generation_id::text
 AND r.response->'transition'->>'operationId'=p.operation_id
 AND r.response->'transition'->>'outcome'=p.outcome
WHERE p.route=(SELECT route FROM input) AND p.realm_id=(SELECT realm_id FROM input) AND p.account_id=(SELECT account_id FROM input)
 AND p.reservation_id=(SELECT reservation_id FROM input) AND p.generation_id=(SELECT generation_id FROM input) AND p.operation_id=(SELECT operation_id FROM input);
