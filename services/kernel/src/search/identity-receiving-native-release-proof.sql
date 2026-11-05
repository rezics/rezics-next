SELECT c.epoch,c.position::text,c.transaction_id::text
FROM search.identity_receiving_native_hold h
JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=
 (h.partition_no,h.released_transaction_id) AND c.xmin=h.xmin AND c.purpose='identity-receiving-custody'
WHERE h.partition_no=$1 AND h.plan_id=$2 AND h.hold_id=$3
 AND (c.xmin=pg_current_xact_id_if_assigned()::xid)=$4::boolean;
