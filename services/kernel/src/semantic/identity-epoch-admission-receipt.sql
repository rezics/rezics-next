SELECT r.*,p.write_state,p.epoch AS owner_epoch,p.position AS owner_position
FROM semantic.identity_epoch_admission_receipt r
JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
 (r.partition_no,r.transaction_id,r.native_epoch,r.native_position) AND c.purpose='admission' AND c.xmin=r.xmin
JOIN core.partition p ON p.partition_no=r.partition_no
WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 AND r.stage=$4 AND r.version=1;
