SELECT DISTINCT original_id::text AS original
 FROM search.identity_receiving_native_plan
 WHERE job_id=$1 AND job_epoch=$2;
