SELECT repair_locator,
 CASE WHEN octet_length(repair_receipt)<=1048576 THEN repair_receipt END AS value
FROM search.identity_writer WHERE partition_no=$1 AND physical_target=$2 AND original_id=$3;
