-- Nine full-key rows and three indexed, one-row absence probes. One source home only.
WITH input AS (SELECT
 $1::integer AS partition_no,
 $2::text AS source_key,
 $3::text AS scope_id,
 $4::uuid AS registration,
 $5::uuid AS capture_id,
 $6::bigint AS revision,
 $7::jsonb AS source,
 $8::integer AS owner_epoch,
 $9::integer AS route,
 $10::uuid AS collection_id,
 $11::integer AS account_route,
 $12::uuid AS account_id,
 $13::text AS incarnation,
 $14::text AS generation,
 $15::text AS scope,
 $16::text AS receiving_epoch,
 $17::text AS effect_key
)
SELECT s.registration::text,s.capture_id::text,s.revision::text,s.state
FROM input i JOIN semantic.identity_scope_summary s
 ON s.partition_no=i.partition_no AND s.source_key=i.source_key AND s.scope_id=i.scope_id
JOIN core.partition p ON p.partition_no=s.partition_no
JOIN library.collection l ON l.route=i.route AND l.collection_id=i.collection_id
JOIN access.account a ON a.route=i.account_route AND a.account_id=i.account_id
JOIN library.native_source_capture c ON c.route=i.route AND c.capture_id=s.capture_id
JOIN library.native_source_receipt r ON r.route=c.route AND r.capture_id=c.capture_id
JOIN library.native_source_hold h ON h.route=c.route AND h.capture_id=c.capture_id AND h.hold_id=s.registration
JOIN library.native_source_fence fc ON fc.route=i.route AND fc.kind='collection' AND fc.owner_id=i.collection_id
JOIN library.native_source_fence fa ON fa.route=i.account_route AND fa.kind='account' AND fa.owner_id=i.account_id
WHERE s.partition_no=i.partition_no AND s.source_key=i.source_key AND s.scope_id=i.scope_id
 AND s.registration=i.registration AND s.capture_id=i.capture_id AND s.revision=i.revision AND s.source=i.source::jsonb
 AND s.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND p.epoch=i.owner_epoch AND p.write_state='active' AND p.moved_to IS NULL
 AND s.state IN ('ready','repair') AND s.active=0 AND s.scan_complete
 AND s.frontier->>'driver'='done' AND s.frontier->>'captureId'=s.capture_id::text
 AND s.capture->>'kind'='library'
 AND s.capture->'capture'->>'captureId'=s.capture_id::text
 AND s.capture->'capture'->'identity'=s.source->'identity'
 AND s.capture->'frontier'->>'captureId'=s.capture_id::text
 AND s.capture->'frontier'->>'driver'='done'
 AND l.curator_account_id=i.account_id AND l.state='active'
 AND l.collection_id::text || ':' || extract(epoch FROM l.created_at)::text=i.incarnation
 AND l.source_generation::text=i.generation AND a.state='active' AND NOT a.authn_fenced
 AND ((i.scope='curated' AND l.membership_kind='curated') OR
      (i.scope='private_builtin' AND l.membership_kind='dynamic' AND
       (l.visibility='private' OR (l.builtin_kind IS NULL AND l.rule_filter IS NOT NULL
        AND l.rule_sort='id' AND l.rule_release_digest IS NOT NULL))))
 AND c.collection_id=i.collection_id AND c.account_id=i.account_id AND c.incarnation=i.incarnation
 AND c.generation::text=i.generation AND c.scope=i.scope AND c.owner_epoch=i.owner_epoch
 AND c.receiving_epoch::text=i.receiving_epoch AND c.effect_key=i.effect_key
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
  WHERE f.partition_no=i.partition_no AND f.source_key=i.source_key AND f.scope_id=i.scope_id LIMIT 1)
 AND NOT EXISTS (SELECT 1 FROM semantic.identity_scope_forward f
  WHERE f.partition_no=i.partition_no AND f.source_key=i.source_key AND f.scope_id=i.scope_id AND f.registration=i.registration
   AND f.ticket IS NULL LIMIT 1)
 AND NOT EXISTS (SELECT 1 FROM semantic.identity_scope_attempt a
  WHERE a.partition_no=i.partition_no AND a.source_key=i.source_key AND a.scope_id=i.scope_id AND a.registration=i.registration
   AND a.state='active' LIMIT 1)
