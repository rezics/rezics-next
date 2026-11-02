DELETE FROM search.identity_receiving_native_scope_pending q
USING semantic.identity_epoch_receiving_plan p,
 semantic.identity_epoch_effect_receipt e,
 semantic.identity_epoch_receiving_custody a,
 semantic.identity_epoch_native_commit c,
 semantic.identity_epoch_job j,core.partition o
WHERE (q.partition_no,q.job_id,q.job_epoch,q.effect_key,q.plan_transaction_id)=($1,$2,$3,$4,$5)
 AND (p.partition_no,p.job_id,p.job_epoch,p.effect_key,p.transaction_id)=
     (q.partition_no,q.job_id,q.job_epoch,q.effect_key,q.plan_transaction_id)
 AND p.binding_digest=$6 AND p.binding->>'step'='search-canonical-index'
 AND (j.partition_no,j.job_id,j.epoch)=(q.partition_no,q.job_id,q.job_epoch)
 AND j.state='pending' AND j.scope_digest=$11
 AND (e.partition_no,e.job_id,e.effect_key)=(q.partition_no,q.job_id,q.effect_key)
 AND e.step='search-canonical-index' AND e.kind=CASE p.binding->'source'->>'disposition'
  WHEN 'OLD' THEN 'remove' WHEN 'handoff' THEN 'pending-fence'
  WHEN 'NEW' THEN 'add' WHEN 'first-apply' THEN 'add' END
 AND (e.native_partition,e.native_epoch,e.native_position,e.native_transaction_id)=($7,$8,$9,$10)
 AND (a.partition_no,a.job_id,a.effect_key)=(q.partition_no,q.job_id,q.effect_key)
 AND (c.partition_no,c.transaction_id)=(a.partition_no,a.transaction_id)
 AND c.purpose='identity-receiving-custody' AND c.xmin=a.xmin
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 AND o.partition_no=q.partition_no AND o.epoch=c.epoch
 AND o.write_state='active' AND o.position>=c.position
RETURNING q.effect_key;
