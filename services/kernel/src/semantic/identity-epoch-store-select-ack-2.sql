SELECT progress FROM semantic.identity_epoch_ack WHERE job_id=$1 AND step=$2 FOR UPDATE;
