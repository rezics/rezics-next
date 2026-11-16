export const lockSearchIdentityOriginalSql = `SELECT incarnation,owner_epoch,writer_token::text,dispatch_state,
  source_position::text,visible_transaction_id::text,visible_position::text,closed_job::text,
  closed_epoch::text,closed_transaction_id::text,repair_locator
 FROM search.identity_writer
 WHERE (partition_no,physical_target,original_id)=($1,$2,$3) FOR UPDATE`;

// The previous exact original may hand off only after its original hold release and job publication.
export const readSearchIdentityPredecessorSql = `SELECT n.plan_id::text
 FROM search.identity_receiving_native_plan n
 JOIN search.identity_receiving_native_hold h USING (partition_no,plan_id)
 JOIN search.identity_receiving_native_operation o USING (partition_no,plan_id)
 JOIN semantic.identity_epoch_native_commit c
   ON (c.partition_no,c.transaction_id)=(h.partition_no,h.released_transaction_id)
   AND c.purpose='identity-receiving-custody' AND c.epoch=$9 AND c.xmin=h.xmin
   AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid
 JOIN semantic.identity_epoch_job j
   ON (j.partition_no,j.job_id,j.epoch)=($8,n.job_id,n.job_epoch) AND j.state='published'
 WHERE (n.partition_no,n.plan_id)=($1,$4)
   AND n.physical_target=$2 AND n.original_id=$3 AND n.document_id=$3
   AND (n.job_id,n.job_epoch)=($5,$6)
   AND n.source->'originalFence'->>'transactionId'=$7
   AND o.state='applied' AND o.hold_id=h.hold_id
   AND NOT EXISTS (SELECT 1 FROM search.identity_receiving_native_pending p
     WHERE (p.partition_no,p.physical_target,p.plan_id)=(n.partition_no,n.physical_target,n.plan_id))`;

export const prepareSearchIdentityOriginalSql = `INSERT INTO search.identity_writer
 (partition_no,physical_target,original_id,incarnation,owner_epoch,dispatch_state,
  closed_job,closed_epoch,closed_transaction_id,closed_position,repair_locator,repair_action)
 VALUES ($1,$2,$3,$4,$5,'cancelled',$6,$7,$8,$9,$10,$11)
 ON CONFLICT (partition_no,physical_target,original_id) DO UPDATE
 SET closed_job=EXCLUDED.closed_job, closed_epoch=EXCLUDED.closed_epoch,
     closed_transaction_id=EXCLUDED.closed_transaction_id, closed_position=EXCLUDED.closed_position,
     repair_locator=EXCLUDED.repair_locator, repair_action=EXCLUDED.repair_action,
     repair_account=NULL
 WHERE identity_writer.incarnation=EXCLUDED.incarnation AND identity_writer.owner_epoch=EXCLUDED.owner_epoch
   AND identity_writer.writer_token IS NULL AND identity_writer.dispatch_state IN ('settled','cancelled')
   AND identity_writer.closed_transaction_id IS NOT DISTINCT FROM $12::uuid
 RETURNING original_id`;

export const readSearchIdentityTargetPendingSql = `SELECT 1 FROM search.identity_receiving_native_pending
 WHERE physical_target=$1 LIMIT 1`;

export const readSearchIdentityHomePendingSql = `SELECT 1 FROM search.identity_receiving_native_pending
 WHERE (partition_no,physical_target)=($1,$2) LIMIT 1`;
