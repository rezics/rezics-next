SELECT j.* FROM semantic.identity_epoch_job j
LEFT JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(j.partition_no,j.recorded_transaction_id) AND c.purpose='admission'
LEFT JOIN editorial.write_basis w ON (w.partition_no,w.transaction_id)=(j.partition_no,j.recorded_transaction_id)
JOIN core.partition p ON p.partition_no=j.partition_no AND p.epoch=coalesce(c.epoch,w.epoch)
 AND p.position>=coalesce(c.position,w.position) AND p.write_state='active'
WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.scope_digest=$4;
