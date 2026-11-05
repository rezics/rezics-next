UPDATE search.identity_receiving_native_copy SET reconciled_transaction_id=$4,settlement=$5::jsonb
WHERE partition_no=$1 AND plan_id=$2 AND copy_no=$3 AND reconciled_transaction_id IS NULL
RETURNING copy_no;
