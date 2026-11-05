SELECT plan_id::text FROM search.identity_receiving_native_pending
WHERE partition_no=$1 AND physical_target=$2 ORDER BY plan_id LIMIT 1;
