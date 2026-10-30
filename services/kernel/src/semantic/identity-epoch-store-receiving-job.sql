SELECT j.scope_digest,j.intent,j.state FROM semantic.identity_epoch_job j
JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(j.partition_no,j.recorded_transaction_id)
JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active' AND p.epoch=c.epoch
WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state IN ('pending','published')
AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
FOR UPDATE OF j;
