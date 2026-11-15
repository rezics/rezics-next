SELECT 1
FROM library.native_public_output_binding b
JOIN library.collection c ON (c.route,c.collection_id)=(b.route,b.collection_id)
JOIN library.collection_retained_output f ON (f.route,f.collection_id,f.generation)=(b.route,b.collection_id,b.output_generation)
JOIN library.collection_source_output g ON (g.route,g.collection_id,g.generation)=(f.route,f.collection_id,f.generation)
JOIN core.partition p ON p.partition_no=b.partition_no
JOIN LATERAL library.frozen_public_output_successor(b.route,b.collection_id,b.output_generation) proof ON true
JOIN library.native_public_output_hold h ON h.partition_no=b.partition_no AND h.hold_id=proof.hold_id
WHERE b.partition_no=$1 AND b.capture_id=$2
FOR SHARE OF c,f,g,p,h;
