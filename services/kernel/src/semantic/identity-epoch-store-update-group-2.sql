UPDATE semantic.identity_epoch_group SET pending_job=NULL,pending_epoch=NULL,published_epoch=$2 WHERE partition_no=$1 AND pending_job=$3;
