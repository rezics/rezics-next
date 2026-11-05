SELECT r.request_digest AS "requestDigest", r.epoch, r.position::text, r.transaction_id AS "transactionId", r.response
FROM core.receipt r
JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
  AND b.epoch=r.epoch AND b.position=r.position
  AND b.principal_kind=r.principal_kind AND b.principal_id=r.principal_id
  AND b.client_id='internal-access' AND b.requested_by IS NULL
JOIN core.partition p ON p.partition_no=r.partition_no
  AND p.write_state='active' AND p.epoch>=r.epoch AND p.position>=r.position
WHERE r.partition_no=:partition_no AND r.principal_kind='account' AND r.principal_id=:service_id::uuid
  AND r.command_kind=:command_kind AND r.idempotency_key=ANY(:receipt_keys::text[])
  AND r.payload_state='present'
LIMIT 1;
