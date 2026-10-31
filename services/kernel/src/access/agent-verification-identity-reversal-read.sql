-- Both arms are unique indexed lookups; neither history nor the account is scanned.
SELECT s.* FROM access.agent_identity_reversal_settlement s
JOIN core.partition p ON p.partition_no=s.partition_no AND p.write_state='active' AND p.moved_to IS NULL
 AND p.epoch=s.owner_epoch AND p.position>=s.position
JOIN core.receipt c ON c.partition_no=s.partition_no AND c.transaction_id=s.transaction_id
 AND c.command_kind='access.agent-verification.reversed'
 AND c.epoch=s.owner_epoch AND c.position=s.position AND c.idempotency_key=s.native_receipt_key
CROSS JOIN core.history_family_domain d
WHERE s.route=$1 AND s.account_id=$2 AND s.verification_receipt_id=$3 AND $4::uuid IS NULL
 AND d.singleton AND d.generation=s.domain_generation
UNION ALL
SELECT s.* FROM access.agent_identity_reversal_settlement s
JOIN core.partition p ON p.partition_no=s.partition_no AND p.write_state='active' AND p.moved_to IS NULL
 AND p.epoch=s.owner_epoch AND p.position>=s.position
JOIN core.receipt c ON c.partition_no=s.partition_no AND c.transaction_id=s.transaction_id
 AND c.command_kind='access.agent-verification.reversed'
 AND c.epoch=s.owner_epoch AND c.position=s.position AND c.idempotency_key=s.native_receipt_key
CROSS JOIN core.history_family_domain d
WHERE s.route=$1 AND s.account_id=$2 AND s.reversal_receipt_id=$4 AND $3::uuid IS NULL
 AND d.singleton AND d.generation=s.domain_generation;
