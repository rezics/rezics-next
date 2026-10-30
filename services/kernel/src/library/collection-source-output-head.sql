-- Same-transaction native publication plus the actual Core commit; locator/metadata alone is never proof.
SELECT h.generation::text AS generation,r.transaction_id::text AS "transactionId",b.position::text AS position,
       r.native_xid::text AS "nativeXid",r.expected_members::text AS members,
       r.member_fence::text AS "memberFence",r.source_generation::text AS "sourceGeneration"
FROM library.collection_source_output_head h
JOIN library.collection_source_output g ON (g.route,g.collection_id,g.generation)=(h.route,h.collection_id,h.generation)
JOIN library.collection_source_output_publication r ON (r.route,r.collection_id,r.generation)=(g.route,g.collection_id,g.generation)
JOIN library.collection s ON s.route=r.route AND s.collection_id=r.collection_id
JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
JOIN core.partition p ON p.partition_no=b.partition_no AND p.epoch=b.epoch AND p.position>=b.position
WHERE h.route=$1 AND h.collection_id=$2 AND h.source_generation=$3 AND r.source_generation=h.source_generation
  AND g.source_generation+1=h.source_generation AND g.state='complete'
  AND s.curator_account_id=r.account_id AND s.state='active' AND s.visibility<>'private'
  AND s.source_generation=r.source_generation
  AND r.incarnation=s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text
  AND g.expected_members=r.expected_members AND g.written_members=r.expected_members
  AND g.member_count=r.expected_members AND g.member_fence=r.member_fence
  AND r.xmin=b.xmin AND r.xmin=g.xmin AND r.xmin=h.xmin
  AND b.principal_kind='account' AND b.position>0 AND p.write_state='active' AND p.moved_to IS NULL
  AND r.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
;
