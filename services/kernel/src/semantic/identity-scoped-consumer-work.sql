-- Released planning read only; the local fence repeats these guards under the writer lock.
SELECT s.revision::text,c.version::text,c.source_generation,c.seal
FROM semantic.identity_scope_summary s
JOIN semantic.identity_scope_attempt a USING(partition_no,source_key,scope_id,registration)
JOIN semantic.identity_scope_completion c USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
JOIN semantic.identity_scope_prearm_receipt r USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
JOIN semantic.identity_epoch_native_commit prepared ON prepared.partition_no=r.partition_no
 AND prepared.transaction_id=r.transaction_id AND prepared.purpose='identity-scope-preparation'
 AND prepared.xmin=r.xmin
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=a.partition_no
 AND n.transaction_id=a.transaction_id AND n.purpose='identity-scope-finish'
 AND n.xmin=a.xmin AND n.xmin=c.xmin
JOIN core.partition p ON p.partition_no=s.partition_no AND p.write_state='active'
 AND p.moved_to IS NULL AND p.epoch=$10 AND p.epoch=n.epoch AND p.position>=n.position
 AND p.epoch=prepared.epoch AND p.position>=prepared.position
WHERE s.partition_no=$1 AND s.source_key=$2 AND s.scope_id=$3 AND s.registration=$4
 AND s.capture_id=$5 AND a.job_id=$6 AND a.job_epoch=$7
 AND a.attempt=$8::jsonb AND c.attempt=a.attempt AND c.capture_id=s.capture_id
 AND r.directory_transaction=$11 AND r.page_id=$12 AND r.ordinal=$13 AND r.disposition='unsafe'
 AND s.source=$9::jsonb AND s.scan_complete AND s.frontier->>'driver'='done'
 AND s.capture->>'kind'='library'
 AND s.capture->'capture'->>'captureId'=s.capture_id::text
 AND s.capture->'frontier'->>'captureId'=s.capture_id::text
 AND s.active=0 AND s.state IN ('ready','repair')
 AND a.state='finished' AND c.complete AND c.seal IS NOT NULL
 AND octet_length(c.source_generation) BETWEEN 1 AND 256
;
