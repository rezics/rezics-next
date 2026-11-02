-- Eight bounded points: summary, component, completion, attempt, forward,
-- association conflict/write, and native foreign-key check. Optional probes are
-- still prepaid at their full one-point bounds.
WITH input AS (SELECT $1::integer AS partition_no,$2::text AS source_key,$3::text AS scope_id,
 $4::jsonb AS source,$5::uuid AS transaction_id,$6::text AS phase,$7::text AS purpose,
 $8::text AS dependency,$9::uuid AS job_id,$10::bigint AS job_epoch),
locked_scope AS MATERIALIZED (
 SELECT s.*,s.xmin AS native_xmin FROM input i JOIN semantic.identity_scope_summary s
  ON s.partition_no=i.partition_no AND s.source_key=i.source_key AND s.scope_id=i.scope_id
 WHERE s.source=i.source FOR UPDATE OF s
)
INSERT INTO semantic.identity_scope_native_association
 (partition_no,source_key,scope_id,registration,capture_id,revision,phase,source,
  transaction_id,epoch,position,purpose,scan_complete,job_id,job_epoch,attempt,completion_version)
SELECT s.partition_no,s.source_key,s.scope_id,s.registration,s.capture_id,s.revision,i.phase,s.source,
 n.transaction_id,n.epoch,n.position,n.purpose,s.scan_complete,c.job_id,c.job_epoch,c.attempt,c.version
FROM input i JOIN locked_scope s
 ON s.partition_no=i.partition_no AND s.source_key=i.source_key AND s.scope_id=i.scope_id
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=i.partition_no AND n.transaction_id=i.transaction_id
LEFT JOIN semantic.identity_scope_completion c ON c.partition_no=i.partition_no AND c.source_key=i.source_key
 AND c.scope_id=i.scope_id AND c.registration=s.registration AND c.job_id=i.job_id AND c.job_epoch=i.job_epoch
LEFT JOIN semantic.identity_scope_attempt a ON a.partition_no=i.partition_no AND a.source_key=i.source_key
 AND a.scope_id=i.scope_id AND a.registration=s.registration AND a.job_id=i.job_id AND a.job_epoch=i.job_epoch
WHERE s.source=i.source AND n.purpose=i.purpose AND n.xmin=pg_current_xact_id()::xid
 AND s.state<>'retired'
 AND (s.native_xmin=n.xmin OR (i.phase='progress' AND c.xmin=n.xmin) OR
  (i.phase='enrollment' AND EXISTS (SELECT 1 FROM semantic.identity_scope_forward f
   WHERE f.partition_no=i.partition_no AND f.source_key=i.source_key AND f.scope_id=i.scope_id
    AND f.registration=s.registration AND f.dependency=i.dependency AND f.xmin=n.xmin)))
 AND (i.phase<>'ready' OR (s.state='ready' AND s.active=0 AND s.scan_complete))
 AND (i.phase<>'finish' OR (a.state='finished' AND a.revision=s.revision
  AND a.transaction_id=n.transaction_id AND a.xmin=n.xmin AND c.xmin=n.xmin
  AND c.complete AND c.seal IS NOT NULL AND c.capture_id=s.capture_id AND c.attempt=a.attempt))
ON CONFLICT (partition_no,source_key,scope_id,registration,capture_id,revision,phase)
DO UPDATE SET source=excluded.source,transaction_id=excluded.transaction_id,
 epoch=excluded.epoch,position=excluded.position,purpose=excluded.purpose,scan_complete=excluded.scan_complete,
 job_id=excluded.job_id,job_epoch=excluded.job_epoch,attempt=excluded.attempt,completion_version=excluded.completion_version
-- A ready replay never overwrites its original committed association.
WHERE semantic.identity_scope_native_association.phase<>'ready'
RETURNING transaction_id;
