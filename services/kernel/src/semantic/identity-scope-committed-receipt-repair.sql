-- Seven full-key rows including the partition point. No foreign read.
WITH input AS (SELECT
 $1::integer AS partition_no,
 $2::text AS source_key,
 $3::text AS scope_id,
 $4::uuid AS registration,
 $5::uuid AS capture_id,
 $6::bigint AS revision,
 $7::jsonb AS source,
 $8::uuid AS job_id,
 $9::bigint AS job_epoch,
 $10::jsonb AS attempt,
 $11::uuid AS directory_transaction,
 $12::text AS page_id,
 $13::integer AS ordinal,
 $14::text AS source_generation,
 $15::integer AS owner_epoch
)
SELECT n.epoch,n.position::text,n.transaction_id::text,c.version::text,c.seal,
 c.source_generation,a.revision::text AS completion_revision
FROM input i JOIN semantic.identity_scope_summary s
 ON s.partition_no=i.partition_no AND s.source_key=i.source_key AND s.scope_id=i.scope_id
JOIN semantic.identity_scope_attempt a ON a.partition_no=s.partition_no AND a.source_key=s.source_key
 AND a.scope_id=s.scope_id AND a.registration=s.registration
JOIN semantic.identity_scope_completion c ON c.partition_no=a.partition_no AND c.source_key=a.source_key
 AND c.scope_id=a.scope_id AND c.registration=a.registration AND c.job_id=a.job_id AND c.job_epoch=a.job_epoch
JOIN semantic.identity_scope_prearm_receipt r ON r.partition_no=a.partition_no AND r.source_key=a.source_key
 AND r.scope_id=a.scope_id AND r.registration=a.registration AND r.job_id=a.job_id AND r.job_epoch=a.job_epoch
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=a.partition_no AND n.transaction_id=a.transaction_id
JOIN semantic.identity_epoch_native_commit prepared ON prepared.partition_no=r.partition_no
 AND prepared.transaction_id=r.transaction_id
WHERE s.partition_no=i.partition_no AND s.source_key=i.source_key AND s.scope_id=i.scope_id AND s.registration=i.registration
 AND s.capture_id=i.capture_id AND s.revision=i.revision AND s.source=i.source::jsonb
 AND a.job_id=i.job_id AND a.job_epoch=i.job_epoch AND a.attempt=i.attempt::jsonb
 AND r.directory_transaction=i.directory_transaction AND r.page_id=i.page_id AND r.ordinal=i.ordinal AND r.disposition='unsafe'
 AND a.state='finished' AND c.attempt=a.attempt AND c.capture_id=s.capture_id
 AND c.complete AND c.seal IS NOT NULL AND c.source_generation=i.source_generation
 AND c.seal->'key'->'sourceIdentity'=s.source->'identity'
 AND c.seal->'key'->>'scope'=s.scope_id
 AND c.seal->'key'->'job'=jsonb_build_object('jobId',a.job_id::text,'epoch',a.job_epoch::text)
 AND (a.revision=s.revision OR (s.state='ready' AND a.revision+1=s.revision))
 AND n.purpose='identity-scope-finish' AND n.xmin=a.xmin AND n.xmin=c.xmin
 AND prepared.purpose='identity-scope-preparation' AND prepared.xmin=r.xmin
 AND n.epoch=i.owner_epoch AND prepared.epoch=i.owner_epoch AND n.position>0 AND prepared.position>0
 AND n.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND prepared.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND EXISTS (SELECT 1 FROM core.partition p WHERE p.partition_no=i.partition_no
  AND p.epoch=i.owner_epoch AND p.write_state='active' AND p.moved_to IS NULL
  AND p.position>=n.position AND p.position>=prepared.position)
