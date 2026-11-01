UPDATE semantic.identity_public_output_gate
SET state=$3,receiving_epoch=original_epoch+1,native_epoch=$4,native_position=$5,
 transaction_id=$6,native_xid=pg_current_xact_id()
WHERE partition_no=$1 AND capture_id=$2 AND state='open' AND original_epoch=$7;
