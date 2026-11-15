-- A frozen recovery job receives only public output and definition locators.
SELECT f.generation::text AS generation,f.transaction_id::text AS "transactionId",
 origin.activation_position::text AS position,f.source_generation::text AS "sourceGeneration",
 COALESCE(c.builtin_release_digest,(
   SELECT digest FROM semantic.definition_activation WHERE route=0 ORDER BY head DESC LIMIT 1
 )) AS "releaseDigest",
 CASE WHEN s.capture_id IS NOT NULL THEN b.binding_digest END AS "sealedBindingDigest"
FROM library.collection_retained_output f
JOIN library.collection c ON c.route=f.route AND c.collection_id=f.collection_id
JOIN LATERAL library.frozen_public_output_origin(f.route,f.collection_id,f.generation) origin ON true
LEFT JOIN library.native_public_output_binding b
 ON b.partition_no=f.partition_no AND b.capture_id=f.generation
 AND b.route=f.route AND b.collection_id=f.collection_id AND b.output_generation=f.generation
 AND b.activation_transaction_id=f.transaction_id AND b.activation_source_generation=f.source_generation
LEFT JOIN library.native_public_output_hold h
 ON h.partition_no=b.partition_no AND h.hold_id=b.hold_id AND h.consumed_by IS NULL
LEFT JOIN semantic.identity_public_output_seal s ON s.partition_no=b.partition_no AND s.capture_id=b.capture_id
WHERE f.route=$1 AND f.collection_id=$2 AND (b.capture_id IS NULL OR h.hold_id IS NOT NULL);
