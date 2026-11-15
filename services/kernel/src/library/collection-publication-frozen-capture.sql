-- The terminal disposer has picked A. Only the managed, sealed predecessor is eligible for transfer.
SELECT b.capture_id::text AS "captureId",b.binding_digest AS "bindingDigest"
FROM library.collection_retained_output f
JOIN library.native_public_output_binding b
 ON b.partition_no=f.partition_no AND b.capture_id=f.generation
 AND b.route=f.route AND b.collection_id=f.collection_id AND b.output_generation=f.generation
 AND b.activation_transaction_id=f.transaction_id AND b.activation_source_generation=f.source_generation
JOIN library.native_public_output_hold h ON h.partition_no=b.partition_no AND h.hold_id=b.hold_id
 AND h.consumed_by IS NULL
JOIN semantic.identity_public_output_seal s ON s.partition_no=b.partition_no AND s.capture_id=b.capture_id
WHERE f.route=$1 AND f.collection_id=$2;
