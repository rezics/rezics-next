SELECT 1 FROM semantic.identity_public_output_consumer
WHERE partition_no=$1 AND capture_id=$2 ORDER BY consumer_id LIMIT 1;
