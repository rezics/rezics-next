-- Four exact points, two capture-completion points, and one attempt absence probe.
WITH input AS (SELECT $1::integer AS partition_no,$2::text AS source_key,$3::text AS scope_id,
 $4::uuid AS registration,$5::uuid AS capture_id,$6::bigint AS revision,$7::jsonb AS source,
 $8::boolean AS initial)
SELECT n.epoch,n.position::text,n.transaction_id::text,a.revision::text AS completion_revision
FROM input i JOIN semantic.identity_scope_summary s
 ON s.partition_no=i.partition_no AND s.source_key=i.source_key AND s.scope_id=i.scope_id
JOIN semantic.identity_scope_native_association a ON a.partition_no=s.partition_no
 AND a.source_key=s.source_key AND a.scope_id=s.scope_id AND a.registration=s.registration
 AND a.capture_id=s.capture_id AND a.revision=s.revision AND a.phase='ready'
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=a.partition_no AND n.transaction_id=a.transaction_id
JOIN core.partition p ON p.partition_no=a.partition_no
WHERE s.registration=i.registration AND s.capture_id=i.capture_id AND s.revision=i.revision AND s.source=i.source
 AND s.state='ready' AND s.active=0 AND s.scan_complete AND a.scan_complete AND a.source=s.source
 AND n.epoch=a.epoch AND n.position=a.position AND n.purpose=a.purpose
 AND n.purpose='identity-scope-registration' AND n.xmin=a.xmin AND n.position>0
 AND p.epoch=n.epoch AND p.position>=n.position AND p.write_state='active' AND p.moved_to IS NULL
 AND a.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND (NOT i.initial OR NOT EXISTS (SELECT 1 FROM semantic.identity_scope_attempt t
   WHERE t.partition_no=i.partition_no AND t.source_key=i.source_key AND t.scope_id=i.scope_id
    AND t.registration=i.registration LIMIT 1))
 AND (NOT i.initial OR EXISTS (
  SELECT 1 FROM semantic.identity_scope_native_association captured
  JOIN semantic.identity_epoch_native_commit cn ON cn.partition_no=captured.partition_no
   AND cn.transaction_id=captured.transaction_id
  WHERE captured.partition_no=i.partition_no AND captured.source_key=i.source_key AND captured.scope_id=i.scope_id
   AND captured.registration=i.registration AND captured.capture_id=i.capture_id
   AND captured.revision=i.revision-1 AND captured.phase='capture' AND captured.scan_complete
   AND captured.source=i.source AND cn.xmin=captured.xmin AND cn.purpose='identity-scope-registration'
   AND cn.epoch=captured.epoch AND cn.position=captured.position AND cn.epoch=n.epoch
   AND cn.position>0 AND cn.position<n.position
   AND captured.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
   /* capture-lock */))
