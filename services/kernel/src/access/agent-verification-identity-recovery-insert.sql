-- Original native component is copied unchanged; the new receipt belongs ONLY to recovery.
WITH input AS (SELECT $16::text AS verification_digest), original AS (
  SELECT r.* FROM core.receipt r
  JOIN core.partition p ON p.partition_no=r.partition_no AND p.write_state='active'
    AND p.epoch=r.epoch AND p.position>=r.position
  WHERE r.partition_no=$1 AND r.principal_kind='account' AND r.principal_id=$7
    AND r.command_kind=$8 AND r.idempotency_key=$9 AND r.transaction_id=$4
    AND r.payload_state='present'
), saved AS (
  INSERT INTO access.agent_identity_intent
  (route,account_id,direction,receipt_id,agent_id,account_kind,catalogue_id,requested_by,decided_by,
   pending_receipt_id,verification_receipt_id,disposition,reason,release,intent,intent_digest,
   source_partition,source_epoch,source_position,source_transaction_id,undo_job_id,undo_job_epoch,
   delivery_key,workflow_id,native_command_kind,native_receipt_key)
  SELECT v.route,v.account_id,'account-agent.unverify',r.transaction_id,$5,v.account_kind,v.catalogue_id,r.principal_id,
    CASE WHEN r.response->>'kind'='revoked' THEN r.principal_id END,
    r.transaction_id,v.receipt_id,r.response->>'kind',r.response->>'reason',v.release,$10::jsonb,$11,
    r.partition_no,r.epoch,r.position,r.transaction_id,$12,$13,$14,$15,r.command_kind,r.idempotency_key
  FROM original r
  JOIN access.agent_identity_intent v ON v.route=$2 AND v.account_id=$3
    AND v.direction='account-agent.verify' AND v.receipt_id=$6
    AND v.intent_digest=(SELECT verification_digest FROM input)
    AND v.source_epoch=r.epoch AND v.source_position<r.position AND NOT v.minimized
  ON CONFLICT (route,account_id,direction,receipt_id) DO NOTHING
  RETURNING *
)
INSERT INTO access.agent_identity_recovery
(route,account_id,direction,receipt_id,requested_by,decided_by,
 source_partition,source_epoch,source_position,source_transaction_id,intent_digest,
 verification_intent_digest,recovery_transaction_id,recovery_epoch,recovery_position,recovery_receipt_key)
SELECT s.route,s.account_id,s.direction,s.receipt_id,s.requested_by,s.decided_by,
 s.source_partition,s.source_epoch,s.source_position,s.source_transaction_id,s.intent_digest,
 (SELECT verification_digest FROM input),$17,p.epoch,p.position+1,$18
FROM saved s JOIN core.partition p ON p.partition_no=s.source_partition AND p.write_state='active'
RETURNING receipt_id;
