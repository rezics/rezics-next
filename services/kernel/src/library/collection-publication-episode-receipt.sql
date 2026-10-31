-- Exact native creation receipt; copied transaction IDs do not reproduce its original commit.
SELECT r.transaction_id::text AS "transactionId",encode(r.request_digest,'hex') AS digest,
       r.response->>'durableInitiator' AS commitment,r.idempotency_key AS "storageKey"
FROM core.receipt r
JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
WHERE r.partition_no=$1 AND r.principal_kind='account' AND r.principal_id=$2
  AND r.command_kind=$3 AND r.idempotency_key=ANY($4::text[]) AND r.idempotency_key=$5
  AND r.payload_state='present' AND r.xmin=b.xmin AND r.position=b.position AND r.epoch=b.epoch
  AND b.principal_kind=r.principal_kind AND b.principal_id=r.principal_id
LIMIT 1;
