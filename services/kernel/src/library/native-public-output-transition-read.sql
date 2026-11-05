SELECT payload, transaction_id::text AS "transactionId", native_xid::text AS "nativeXid", xmin::text,
       epoch,position::text FROM library.native_public_output_transition
WHERE partition_no=$1 AND hold_id=$2 FOR SHARE;
