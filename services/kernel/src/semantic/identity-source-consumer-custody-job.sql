SELECT j.scope_digest
FROM semantic.identity_epoch_job j
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=j.partition_no
  AND n.transaction_id=j.recorded_transaction_id AND n.purpose='admission'
JOIN core.partition p ON p.partition_no=j.partition_no AND p.write_state='active'
  AND p.epoch=n.epoch AND p.position>=n.position
JOIN semantic.identity_epoch_control c ON c.partition_no=j.partition_no
WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state='published'
  AND c.published_epoch>=j.epoch AND c.pending_job IS DISTINCT FROM j.job_id
FOR SHARE OF j,n,p,c;
