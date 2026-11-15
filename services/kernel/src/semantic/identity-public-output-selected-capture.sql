SELECT b.capture_id::text AS "captureId",b.binding_digest AS "bindingDigest"
FROM library.collection_source_output_head h
JOIN library.native_public_output_binding b
 ON b.partition_no=(h.route >> 4) AND b.capture_id=h.generation
 AND b.route=h.route AND b.collection_id=h.collection_id AND b.output_generation=h.generation
 AND b.activation_source_generation=h.source_generation
WHERE h.route=$1 AND h.collection_id=$2 AND h.source_generation=$3;
