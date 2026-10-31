SELECT t.*,p.epoch AS current_epoch,p.position::text AS current_position,
 p.write_state AS current_write_state,d.generation::text AS current_domain,
 t.xmin::text=pg_current_xact_id()::text AS same_transaction
FROM access.agent_identity_technical_source t
JOIN core.partition p ON p.partition_no=t.source_partition
CROSS JOIN core.history_family_domain d
WHERE t.route=$1 AND t.account_id=$2 AND t.direction=$3 AND t.receipt_id=$4 AND d.singleton
FOR SHARE OF t,p,d;
