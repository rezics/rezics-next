-- Allocation limits the raw generations to two. Query the managed capture at each exact generation.
SELECT b.capture_id::text AS "captureId",b.binding_digest AS "bindingDigest"
FROM library.collection c
JOIN library.collection_source_output g ON g.route=c.route AND g.collection_id=c.collection_id
JOIN library.native_public_output_binding b ON b.partition_no=(g.route >> 4) AND b.capture_id=g.generation
 AND b.route=g.route AND b.collection_id=g.collection_id AND b.output_generation=g.generation
JOIN library.native_public_output_hold h ON h.partition_no=b.partition_no AND h.hold_id=b.hold_id
 AND h.consumed_by IS NULL
WHERE c.route=$1 AND c.collection_id=$2 AND c.builtin_kind IN ('everything','state')
 AND c.source_generation>b.activation_source_generation
 AND NOT EXISTS (
   SELECT 1 FROM library.collection_retained_output f
   WHERE f.route=c.route AND f.collection_id=c.collection_id AND f.generation=g.generation
 )
ORDER BY g.generation
LIMIT 1;
