UPDATE search.identity_receiving_native_hold
SET accepted_epoch=$4,accepted_position=$5
WHERE partition_no=$1 AND plan_id=$2 AND accepted_transaction_id=$3
 AND accepted_epoch IS NULL AND xmin=pg_current_xact_id_if_assigned()::xid
RETURNING hold_id;
