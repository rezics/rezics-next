SELECT progress FROM semantic.identity_epoch_ack WHERE partition_no=$3 AND job_id=$1 AND step=$2 FOR UPDATE;
