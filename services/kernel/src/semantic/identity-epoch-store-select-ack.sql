SELECT step,progress FROM semantic.identity_epoch_ack WHERE partition_no=$2 AND job_id=$1;
