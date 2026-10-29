UPDATE semantic.identity_epoch_group SET pending_job=$2,pending_epoch=$3 WHERE partition_no=$1 AND terminal=ANY($4::uuid[]);
