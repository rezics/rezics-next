UPDATE semantic.identity_epoch_admission_plan SET waiting=false,prepared_transaction_id=$3,
 prepared_epoch=$4,prepared_position=$5
WHERE partition_no=$6 AND job_id=$1 AND resource_home=$2
 AND (prepared_transaction_id IS NULL OR prepared_transaction_id=$3);
