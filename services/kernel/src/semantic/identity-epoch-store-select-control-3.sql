SELECT pending_job,pending_epoch FROM semantic.identity_epoch_control WHERE partition_no=$1 FOR UPDATE;
