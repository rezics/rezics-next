SELECT i.*, p.epoch AS current_epoch,p.position::text AS current_position
FROM access.agent_identity_intent i
JOIN core.partition p ON p.partition_no=i.source_partition AND p.write_state='active'
WHERE i.route=$1 AND i.account_id=$2 AND i.direction=$3 AND i.receipt_id=$4
FOR SHARE OF i;
