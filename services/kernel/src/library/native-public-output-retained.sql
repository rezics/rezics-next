-- Retention is independent of current visibility, source fence and selected head.
SELECT 1 FROM library.native_public_output_binding b
JOIN library.collection_source_output_publication r ON r.route=b.route AND r.collection_id=b.collection_id AND r.generation=b.output_generation
JOIN library.collection_source_output g ON g.route=r.route AND g.collection_id=r.collection_id AND g.generation=r.generation
JOIN editorial.write_basis w ON w.partition_no=r.partition_no AND w.transaction_id=r.transaction_id
JOIN core.partition p ON p.partition_no=w.partition_no AND p.epoch=w.epoch AND p.position>=w.position
WHERE b.partition_no=$1 AND b.capture_id=$2 AND b.incarnation=r.incarnation
 AND r.transaction_id=b.activation_transaction_id AND w.position=b.activation_position
 AND r.source_generation=b.activation_source_generation AND w.epoch=b.owner_epoch
 AND w.principal_kind='account' AND r.xmin=w.xmin AND r.xmin=g.xmin
 AND g.state='complete' AND g.expected_members=r.expected_members AND g.written_members=r.expected_members
 AND g.member_count=r.expected_members AND g.member_fence=r.member_fence
 AND p.write_state='active' AND p.moved_to IS NULL
FOR SHARE OF r,g,w;
