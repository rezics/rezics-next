WITH input AS (SELECT $5::uuid AS job_id,$6::bigint AS job_epoch)
SELECT s.frontier,s.state
FROM semantic.identity_epoch_step s
CROSS JOIN input i
JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
 (s.partition_no,s.transaction_id,s.native_epoch,s.native_position)
 AND c.purpose='search-canonical-index' AND c.xmin=s.xmin
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
JOIN core.partition p ON p.partition_no=c.partition_no AND p.epoch=c.epoch
 AND p.write_state='active' AND p.position>=c.position
JOIN semantic.identity_epoch_job j ON (j.partition_no,j.job_id,j.epoch)=($7,i.job_id,i.job_epoch)
WHERE (s.partition_no,s.transaction_id,s.native_epoch,s.native_position)=($1,$2,$3,$4)
 AND s.job_id=i.job_id AND s.job_epoch=i.job_epoch AND s.step='search-canonical-index' AND s.version=1
 AND s.scope_digest=j.scope_digest AND s.state='complete'
 AND NOT EXISTS (SELECT 1 FROM search.identity_receiving_native_scope_pending q
  WHERE (q.partition_no,q.job_id,q.job_epoch)=(j.partition_no,j.job_id,j.epoch));
