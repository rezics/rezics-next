SELECT job_id,epoch,intent,receipt FROM semantic.identity_epoch_job WHERE partition_no=$2 AND receipt_key=$1;
