-- Nine full-key rows and three indexed, one-row absence probes. One source home only.
SELECT s.registration::text,s.capture_id::text,s.revision::text
FROM semantic.identity_scope_summary s
JOIN core.partition p ON p.partition_no=s.partition_no
JOIN library.collection l ON l.route=$9 AND l.collection_id=$10
JOIN access.account a ON a.route=$11 AND a.account_id=$12
JOIN library.native_source_capture c ON c.route=$9 AND c.capture_id=s.capture_id
JOIN library.native_source_receipt r ON r.route=c.route AND r.capture_id=c.capture_id
JOIN library.native_source_hold h ON h.route=c.route AND h.capture_id=c.capture_id AND h.hold_id=s.registration
JOIN library.native_source_fence fc ON fc.route=$9 AND fc.kind='collection' AND fc.owner_id=$10
JOIN library.native_source_fence fa ON fa.route=$11 AND fa.kind='account' AND fa.owner_id=$12
WHERE s.partition_no=$1 AND s.source_key=$2 AND s.scope_id=$3
 AND s.registration=$4 AND s.capture_id=$5 AND s.revision=$6 AND s.source=$7::jsonb
 AND s.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND p.epoch=$8 AND p.write_state='active' AND p.moved_to IS NULL
 AND s.state IN ('ready','repair') AND s.active=0 AND s.scan_complete
 AND s.frontier->>'driver'='done' AND s.frontier->>'captureId'=s.capture_id::text
 AND s.capture->>'kind'='library'
 AND s.capture->'capture'->>'captureId'=s.capture_id::text
 AND s.capture->'capture'->'identity'=s.source->'identity'
 AND s.capture->'frontier'->>'captureId'=s.capture_id::text
 AND s.capture->'frontier'->>'driver'='done'
 AND l.curator_account_id=$12 AND l.state='active'
 AND l.collection_id::text || ':' || extract(epoch FROM l.created_at)::text=$13
 AND l.source_generation::text=$14 AND a.state='active' AND NOT a.authn_fenced
 AND (($15='curated' AND l.membership_kind='curated') OR
      ($15='private_builtin' AND l.membership_kind='dynamic' AND
       (l.visibility='private' OR (l.builtin_kind IS NULL AND l.rule_filter IS NOT NULL
        AND l.rule_sort='id' AND l.rule_release_digest IS NOT NULL))))
 AND c.collection_id=$10 AND c.account_id=$12 AND c.incarnation=$13
 AND c.generation::text=$14 AND c.scope=$15 AND c.owner_epoch=$8
 AND c.receiving_epoch::text=$16 AND c.effect_key=$17
 AND c.complete AND c.driver='done'
 AND c.collection_fence=fc.generation AND c.account_fence=fa.generation
 AND r.xmin=c.xmin AND r.owner_epoch=p.epoch AND r.position>0 AND r.position<=p.position
 AND r.transaction_id::text=s.capture->'capture'->>'transactionId'
 AND r.position::text=s.capture->'capture'->>'position'
 AND c.scanned::text=s.capture->'capture'->>'scanned'
 AND c.scanned::text=s.capture->'frontier'->>'scanned'
 AND c.version::text=s.capture->'frontier'->>'version'
 AND c.after_key=s.capture->'frontier'->>'after'
 AND c.tie=s.capture->'frontier'->>'tie'
 AND c.session_id::text IS NOT DISTINCT FROM s.capture->'frontier'->>'sessionId'
 AND r.native_xid IS DISTINCT FROM pg_current_xact_id_if_assigned()
 AND h.transaction_id=r.transaction_id AND NOT h.released
 AND h.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND NOT EXISTS (SELECT 1 FROM semantic.identity_scope_consumer_fence f
  WHERE f.partition_no=$1 AND f.source_key=$2 AND f.scope_id=$3 LIMIT 1)
 AND NOT EXISTS (SELECT 1 FROM semantic.identity_scope_forward f
  WHERE f.partition_no=$1 AND f.source_key=$2 AND f.scope_id=$3 AND f.registration=$4
   AND f.ticket IS NULL LIMIT 1)
 AND NOT EXISTS (SELECT 1 FROM semantic.identity_scope_attempt a
  WHERE a.partition_no=$1 AND a.source_key=$2 AND a.scope_id=$3 AND a.registration=$4
   AND a.state='active' LIMIT 1)
