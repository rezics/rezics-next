SELECT j.state,c.epoch,c.position::text,c.transaction_id::text
FROM semantic.identity_epoch_job j
JOIN semantic.identity_epoch_effect_receipt e
 ON (e.partition_no,e.job_id)=(j.partition_no,j.job_id) AND e.step='search-canonical-index' AND e.effect_key=$4
JOIN semantic.identity_epoch_receiving_custody a
 ON (a.partition_no,a.job_id,a.effect_key)=(e.partition_no,e.job_id,e.effect_key)
JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id)=(a.partition_no,a.transaction_id)
 AND c.purpose='identity-receiving-custody' AND c.xmin=a.xmin
JOIN core.partition p ON p.partition_no=j.partition_no AND p.epoch=c.epoch AND p.write_state='active'
 AND p.position>=c.position
WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.scope_digest=$5 AND j.state IN ('pending','published')
 AND e.native_partition=$6 AND e.native_epoch=$7 AND e.native_position=$8 AND e.native_transaction_id=$9
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid;
