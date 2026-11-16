-- The successor's committed Search close names the exact predecessor of this common gate.
SELECT r.job_id,r.job_epoch::text,r.effect_key,r.transaction_id,
       h.accepted_epoch,h.accepted_position::text,o.applied_transaction_id,h.released_transaction_id
FROM search.identity_receiving_native_plan n
JOIN semantic.identity_epoch_native_commit c
  ON (c.partition_no,c.transaction_id)=(n.partition_no,n.transaction_id)
 AND c.purpose='search-canonical-index' AND c.xmin=n.xmin
 AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
JOIN core.partition p ON p.partition_no=n.partition_no AND p.epoch=c.epoch
 AND p.write_state='active' AND p.position>=c.position
JOIN search.identity_writer w
  ON (w.partition_no,w.physical_target,w.original_id)=(n.partition_no,n.physical_target,n.original_id)
 AND (w.closed_job,w.closed_epoch,w.closed_transaction_id,w.closed_position)=(n.job_id,n.job_epoch,c.transaction_id,c.position)
 AND w.owner_epoch=c.epoch AND w.repair_locator=n.plan_id::text AND w.writer_token IS NULL
 AND w.dispatch_state IN ('settled','cancelled')
JOIN search.identity_writer_gate target
  ON (target.partition_no,target.physical_target)=(w.partition_no,w.physical_target)
 AND target.owner_epoch=c.epoch AND target.incarnation=w.incarnation AND target.incarnation=n.source->>'incarnation'
 AND target.consumer=n.source->>'consumer' AND target.write_alias=n.source->>'writeAlias'
 AND target.closed_token IS NULL AND target.fence_generation=(n.source->>'fenceGeneration')::bigint
 AND target.enrollment_generation>=(n.source->>'enrollmentGeneration')::bigint
JOIN semantic.identity_epoch_receiving_gate g
  ON (g.partition_no,g.owner_id,g.original,g.owner_epoch)=(n.partition_no,n.original_id,n.original_id,c.epoch)
JOIN search.identity_receiving_native_plan prior
  ON prior.partition_no=n.partition_no AND prior.plan_id=(n.obligations#>>'{predecessor,planId}')::uuid
 AND (prior.job_id,prior.job_epoch)=(g.pending_job,g.pending_epoch)
 AND (prior.physical_target,prior.original_id,prior.document_id)=(n.physical_target,n.original_id,n.original_id)
JOIN search.identity_receiving_native_hold h ON (h.partition_no,h.plan_id)=(prior.partition_no,prior.plan_id)
JOIN search.identity_receiving_native_operation o
  ON (o.partition_no,o.plan_id,o.hold_id)=(h.partition_no,h.plan_id,h.hold_id) AND o.state='applied'
JOIN semantic.identity_epoch_receiving_record r
  ON (r.partition_no,r.job_id,r.effect_key)=(prior.partition_no,prior.job_id,prior.effect_key)
 AND (r.job_epoch,r.owner_id,r.original,r.owner_epoch)=(prior.job_epoch,g.owner_id,g.original,g.owner_epoch)
 AND r.transaction_id=h.accepted_transaction_id AND r.owner_epoch=h.accepted_epoch
 AND r.native_hold->>'holdId'=h.hold_id::text AND r.binding->'source'=prior.source
JOIN semantic.identity_epoch_receiving_search_progress s
  ON (s.partition_no,s.job_id,s.effect_key)=(r.partition_no,r.job_id,r.effect_key)
 AND (s.owner_id,s.original,s.accepted_transaction_id,s.binding_digest)=(r.owner_id,r.original,r.transaction_id,r.binding_digest)
 AND s.state='released' AND s.applied_transaction_id=o.applied_transaction_id
 AND s.released_transaction_id=h.released_transaction_id
JOIN semantic.identity_epoch_native_commit released
  ON (released.partition_no,released.transaction_id)=(s.partition_no,s.released_transaction_id)
 AND released.purpose='identity-receiving-custody' AND released.epoch=c.epoch AND released.position<c.position
 AND released.xmin=s.xmin AND released.xmin=h.xmin
 AND released.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
WHERE (n.partition_no,n.plan_id,n.job_id,n.job_epoch,n.original_id)=($1,$2,$3,$4,$5)
 AND n.job_id<>prior.job_id
 AND NOT EXISTS (
   SELECT 1 FROM semantic.identity_epoch_receiving_search_progress sibling
   WHERE (sibling.partition_no,sibling.job_id,sibling.owner_id,sibling.original)=(r.partition_no,r.job_id,r.owner_id,r.original)
     AND sibling.state<>'released'
 )
 AND NOT EXISTS (
   SELECT 1 FROM search.identity_receiving_native_pending pending
   WHERE (pending.partition_no,pending.physical_target,pending.plan_id)=(prior.partition_no,prior.physical_target,prior.plan_id)
 );
