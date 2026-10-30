SELECT r.*,c.epoch AS native_epoch,c.position AS native_position
FROM semantic.identity_epoch_receiving_plan r
JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id)
 AND c.purpose='identity-receiving-plan' AND c.xmin=r.xmin AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
JOIN core.partition p ON p.partition_no=r.partition_no AND p.epoch=c.epoch
 AND p.write_state='active' AND p.position>=c.position
WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 AND r.effect_key=$4;
