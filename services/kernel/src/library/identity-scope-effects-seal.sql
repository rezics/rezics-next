-- Immutable native commit provenance anchors this exact terminal raw frontier, generation and version.
SELECT c.partition_no AS partition,c.epoch,c.position::text,c.transaction_id::text AS "transactionId"
FROM library.identity_scope_seal s
JOIN library.identity_scope_plan p USING(route,collection_id,plan_key)
JOIN library.canonical_source_generation g ON (g.route,g.collection_id,g.generation)=(p.route,p.collection_id,p.generation)
 AND g.state='working' AND g.source_exhausted AND g.driver='done' AND g.version=p.version
JOIN semantic.identity_epoch_native_commit c
 ON c.partition_no=(s.route >> 4) AND c.transaction_id=s.transaction_id AND c.xmin=s.xmin
 AND c.purpose='library-private-follow-counts'
JOIN core.partition o ON o.partition_no=c.partition_no AND o.epoch=c.epoch AND o.position>=c.position
 AND o.write_state='active' AND o.moved_to IS NULL
WHERE s.route=$1 AND s.collection_id=$2 AND s.plan_key=$3 AND s.version=p.version
 AND s.transaction_id=p.seal_transaction_id AND p.state='sealed' AND p.driver='done' AND p.phase='raw'
 AND s.generation=p.generation AND s.frontier=p.frontier AND s.capture_frontier=p.capture_frontier
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
FOR SHARE OF s,g,c,o;
