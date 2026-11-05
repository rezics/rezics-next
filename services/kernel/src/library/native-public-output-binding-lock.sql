SELECT b.payload, b.binding_digest AS "bindingDigest", b.native_xid::text AS "nativeXid",
       b.accepted_transaction_id::text AS "transactionId", b.owner_epoch AS epoch,
       b.accepted_position::text AS position, f.receiving_epoch::text AS "receivingEpoch", f.state,
       h.consumed_by::text AS "consumedBy"
FROM library.native_public_output_binding b
JOIN library.native_public_output_receiving f USING(partition_no,capture_id)
JOIN library.native_public_output_hold h ON h.partition_no=b.partition_no AND h.hold_id=b.hold_id
WHERE b.partition_no=$1 AND b.capture_id=$2
FOR SHARE OF b FOR UPDATE OF f,h;
