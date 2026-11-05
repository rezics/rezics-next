UPDATE semantic.identity_epoch_group SET observed_count=observed_count-1,version=version+1 WHERE partition_no=$2 AND terminal=$1;
