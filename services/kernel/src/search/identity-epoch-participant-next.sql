SELECT p.binding,p.binding_digest,p.transaction_id AS plan_transaction_id,j.scope_digest
FROM search.identity_receiving_native_scope_pending q
JOIN semantic.identity_epoch_receiving_plan p
 ON (p.partition_no,p.job_id,p.job_epoch,p.effect_key,p.transaction_id)=
 (q.partition_no,q.job_id,q.job_epoch,q.effect_key,q.plan_transaction_id)
JOIN semantic.identity_epoch_native_commit c
 ON (c.partition_no,c.transaction_id)=(p.partition_no,p.transaction_id)
 AND c.purpose='identity-receiving-plan' AND c.xmin=p.xmin
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
JOIN semantic.identity_epoch_job j
 ON (j.partition_no,j.job_id,j.epoch)=(p.partition_no,p.job_id,p.job_epoch)
JOIN semantic.identity_epoch_effect_receipt e
 ON (e.partition_no,e.job_id,e.effect_key)=(p.partition_no,p.job_id,p.effect_key)
 AND e.step='search-canonical-index' AND e.kind=CASE p.binding->'source'->>'disposition'
  WHEN 'OLD' THEN 'remove' WHEN 'handoff' THEN 'pending-fence'
  WHEN 'NEW' THEN 'add' WHEN 'first-apply' THEN 'add' END
JOIN core.partition o ON o.partition_no=p.partition_no AND o.epoch=c.epoch
 AND o.write_state='active' AND o.position>=c.position
WHERE q.partition_no=$1 AND q.job_id=$2 AND q.job_epoch=$3 AND j.state='pending'
 AND p.binding->>'step'='search-canonical-index'
ORDER BY q.effect_key
LIMIT 1;
