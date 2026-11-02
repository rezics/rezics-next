SELECT copy_no FROM search.identity_receiving_native_copy
WHERE partition_no=$1 AND plan_id=$2 ORDER BY copy_no DESC LIMIT 1;
