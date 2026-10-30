-- The partial native transaction index admits at most one original reversal receipt.
SELECT r.principal_id,r.command_kind,r.idempotency_key,r.request_digest,r.epoch,
       r.position::text,r.transaction_id,r.response,r.payload_state,
       b.principal_id AS basis_actor,b.client_id,b.requested_by AS basis_requested_by,
       p.epoch AS current_epoch,p.position::text AS current_position
FROM core.receipt r
JOIN core.partition p ON p.partition_no=r.partition_no AND p.write_state='active'
LEFT JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
  AND b.principal_kind=r.principal_kind AND b.principal_id=r.principal_id
  AND b.epoch=r.epoch AND b.position=r.position
WHERE r.partition_no=$1 AND r.transaction_id=$2 AND r.principal_kind='account'
  AND r.command_kind IN ('access.agent-verification.released','access.agent-verification.revoked',
                         'access.agent-verification.deleted')
FOR SHARE OF r;
