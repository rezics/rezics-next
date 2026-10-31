SELECT 1 FROM semantic.identity_scope_consumer_fence
WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4
 AND job_id=$5 AND job_epoch=$6;
