SELECT copy_no FROM search.identity_receiving_native_copy
WHERE partition_no=$1 AND plan_id=$2 AND reconciled_transaction_id IS NULL
ORDER BY copy_no LIMIT 1;
