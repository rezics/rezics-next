SELECT 1 FROM semantic.identity_epoch_job j
JOIN semantic.identity_epoch_admission_receipt r ON (r.partition_no,r.job_id,r.job_epoch)=(j.partition_no,j.job_id,j.epoch) AND r.stage='closed'
JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id,c.epoch,c.position)=(r.partition_no,r.transaction_id,r.native_epoch,r.native_position) AND c.xmin=r.xmin
JOIN core.partition p ON p.partition_no=j.partition_no AND p.epoch=c.epoch AND p.position>=c.position
WHERE j.partition_no=$1 AND j.job_id=$2 AND j.epoch=$3 AND j.state IN ('cancelling','cancelled') AND c.transaction_id=$4 AND c.epoch=$5 AND c.position=$6
AND p.write_state='active' AND p.moved_to IS NULL;
