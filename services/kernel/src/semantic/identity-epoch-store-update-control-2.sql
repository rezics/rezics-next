UPDATE semantic.identity_epoch_control SET published_epoch=$2,pending_job=NULL,pending_epoch=NULL,prepare_job=NULL,prepare_epoch=NULL WHERE partition_no=$1;
