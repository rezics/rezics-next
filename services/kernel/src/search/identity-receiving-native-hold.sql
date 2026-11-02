SELECT h.hold_id::text,h.accepted_transaction_id::text,h.accepted_epoch,
 h.accepted_position::text,h.released_transaction_id::text
FROM search.identity_receiving_native_hold h
WHERE h.partition_no=$1 AND h.plan_id=$2 FOR UPDATE;
