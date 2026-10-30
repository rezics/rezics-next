UPDATE semantic.identity_epoch_receipt_binding b SET state='accepted',accepted_job=$4,accepted_epoch=$5
WHERE b.partition_no=$1 AND b.receipt_key=$2 AND b.generation=$3 AND b.state IN ('pending','accepted')
 AND (b.accepted_job IS NULL OR (b.accepted_job,b.accepted_epoch)=($4::uuid,$5::bigint));
