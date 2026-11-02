-- Seven full-key rows including the partition point. No foreign read.
SELECT n.epoch,n.position::text,n.transaction_id::text,c.version::text,c.seal,
 c.source_generation,a.revision::text AS completion_revision
FROM semantic.identity_scope_summary s
JOIN semantic.identity_scope_attempt a USING(partition_no,source_key,scope_id,registration)
JOIN semantic.identity_scope_completion c USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
JOIN semantic.identity_scope_prearm_receipt r USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=a.partition_no AND n.transaction_id=a.transaction_id
JOIN semantic.identity_epoch_native_commit prepared ON prepared.partition_no=r.partition_no
 AND prepared.transaction_id=r.transaction_id
WHERE s.partition_no=$1 AND s.source_key=$2 AND s.scope_id=$3 AND s.registration=$4
 AND s.capture_id=$5 AND s.revision=$6 AND s.source=$7::jsonb
 AND a.job_id=$8 AND a.job_epoch=$9 AND a.attempt=$10::jsonb
 AND r.directory_transaction=$11 AND r.page_id=$12 AND r.ordinal=$13 AND r.disposition='unsafe'
 AND a.state='finished' AND c.attempt=a.attempt AND c.capture_id=s.capture_id
 AND c.complete AND c.seal IS NOT NULL AND c.source_generation=$14
 AND c.seal->'key'->'sourceIdentity'=s.source->'identity'
 AND c.seal->'key'->>'scope'=s.scope_id
 AND c.seal->'key'->'job'=jsonb_build_object('jobId',a.job_id::text,'epoch',a.job_epoch::text)
 AND (a.revision=s.revision OR (s.state='ready' AND a.revision+1=s.revision))
 AND n.purpose='identity-scope-finish' AND n.xmin=a.xmin AND n.xmin=c.xmin
 AND prepared.purpose='identity-scope-preparation' AND prepared.xmin=r.xmin
 AND n.epoch=$15 AND prepared.epoch=$15 AND n.position>0 AND prepared.position>0
 AND n.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND prepared.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND EXISTS (SELECT 1 FROM core.partition p WHERE p.partition_no=$1
  AND p.epoch=$15 AND p.write_state='active' AND p.moved_to IS NULL
  AND p.position>=n.position AND p.position>=prepared.position)
