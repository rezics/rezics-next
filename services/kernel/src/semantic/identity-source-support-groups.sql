SELECT generation::text,version::text,pending_job::text,pending_epoch::text
FROM semantic.identity_epoch_group WHERE partition_no=$1 AND terminal=$2;
