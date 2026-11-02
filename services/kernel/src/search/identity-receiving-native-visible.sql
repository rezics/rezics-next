UPDATE search.identity_receiving_native_operation
SET state='visible',visible_transaction_id=$4,visible_position=$5,writer_evidence_digest=$6
WHERE partition_no=$1 AND plan_id=$2 AND operation_id=$3 AND state='dispatched'
RETURNING operation_id;
