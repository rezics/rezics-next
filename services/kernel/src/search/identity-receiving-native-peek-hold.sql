SELECT hold_id::text,accepted_transaction_id::text,accepted_epoch,accepted_position::text,released_transaction_id::text
FROM search.identity_receiving_native_hold WHERE partition_no=$1 AND plan_id=$2;
