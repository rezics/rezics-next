UPDATE semantic.identity_epoch_control SET allocated_epoch=$2,pending_epoch=$2,pending_job=$3 WHERE partition_no=$1;
