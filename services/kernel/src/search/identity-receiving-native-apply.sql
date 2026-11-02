UPDATE search.identity_receiving_native_operation
SET state='applied',applied_transaction_id=$4,frontier=$5::jsonb
WHERE partition_no=$1 AND plan_id=$2 AND operation_id=$3 AND state='visible'
RETURNING operation_id;
