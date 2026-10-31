-- The output hook callback has inserted B, but only this actual Core command may complete its episode.
SELECT p.generation::text AS generation,p.transaction_id::text AS "transactionId",
       p.native_xid::text AS "nativeXid",p.source_generation::text AS "sourceGeneration",
       p.expected_members::text AS members,p.member_fence::text AS "memberFence"
FROM library.collection_source_output_publication p
JOIN library.collection_source_output g USING(route,collection_id,generation)
JOIN library.collection_source_output_head h USING(route,collection_id,generation)
JOIN library.collection c ON c.route=p.route AND c.collection_id=p.collection_id
WHERE p.route=:route AND p.collection_id=:collection_id AND p.generation=:generation
  AND p.account_id=:owner_account_id AND p.transaction_id=:transaction_id
  AND p.native_xid=pg_current_xact_id_if_assigned()
  AND p.source_generation=:source_generation AND h.source_generation=p.source_generation
  AND g.state='complete' AND g.output_mode='whole_query'
  AND g.expected_members IS NOT NULL AND g.expected_members=g.written_members
  AND g.member_count=g.expected_members AND g.account_id=p.account_id
  AND g.source_generation+1=p.source_generation
  AND h.generation=p.generation
  AND c.curator_account_id=p.account_id AND c.state='active' AND c.membership_kind='dynamic'
  AND c.visibility=:visibility AND c.source_generation=p.source_generation;
