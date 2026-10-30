-- Account command provenance is retained separately from the accepted Source claim.
WITH parameters AS (SELECT $1::integer AS partition), input AS (
  SELECT * FROM jsonb_to_record($2::jsonb) AS x(
    route integer,account_id uuid,direction text,receipt_id uuid,agent_id uuid,account_kind text,catalogue_id uuid,
    request_id uuid,requested_by uuid,decided_by uuid,decision_epoch integer,decision_position bigint,
    decision_transaction_id uuid,pending_receipt_id uuid,verification_receipt_id uuid,disposition text,reason text,
    release text,intent jsonb,intent_digest text,source_epoch integer,source_position bigint,source_transaction_id uuid,
    undo_job_id uuid,undo_job_epoch bigint,delivery_key text,workflow_id text,native_command_kind text,native_receipt_key text,
    verification_intent_digest text,original_source jsonb,recovery_transaction_id uuid,recovery_receipt_key text,
    recovery_digest text)
), saved AS (
  INSERT INTO access.agent_identity_intent
  (route,account_id,direction,receipt_id,agent_id,account_kind,catalogue_id,request_id,requested_by,decided_by,
   decision_route,decision_receipt_id,decision_epoch,decision_position,decision_transaction_id,
   pending_receipt_id,verification_receipt_id,disposition,reason,release,intent,intent_digest,
   source_partition,source_epoch,source_position,source_transaction_id,undo_job_id,undo_job_epoch,
   delivery_key,workflow_id,native_command_kind,native_receipt_key)
  SELECT x.route,x.account_id,x.direction,x.receipt_id,x.agent_id,x.account_kind,x.catalogue_id,x.request_id,
    x.requested_by,x.decided_by,CASE WHEN x.request_id IS NOT NULL THEN 0 END,
    x.decision_transaction_id,x.decision_epoch,x.decision_position,x.decision_transaction_id,
    x.pending_receipt_id,x.verification_receipt_id,x.disposition,x.reason,x.release,x.intent,x.intent_digest,
    (SELECT partition FROM parameters),x.source_epoch,x.source_position,x.source_transaction_id,x.undo_job_id,x.undo_job_epoch,
    x.delivery_key,x.workflow_id,x.native_command_kind,x.native_receipt_key
  FROM input x
  WHERE EXISTS (SELECT 1 FROM core.receipt r WHERE r.partition_no=(SELECT partition FROM parameters) AND r.principal_kind='account'
    AND r.principal_id=x.requested_by AND r.command_kind=x.native_command_kind AND r.idempotency_key=x.native_receipt_key
    AND r.transaction_id=x.source_transaction_id AND r.epoch=x.source_epoch AND r.position=x.source_position
    AND r.payload_state='present')
  ON CONFLICT (route,account_id,direction,receipt_id) DO NOTHING RETURNING *
)
INSERT INTO access.agent_identity_recovery
(route,account_id,direction,receipt_id,requested_by,decided_by,source_partition,source_epoch,source_position,
 source_transaction_id,intent_digest,verification_intent_digest,original_source,recovery_transaction_id,
 recovery_epoch,recovery_position,recovery_receipt_key,recovery_digest)
SELECT s.route,s.account_id,s.direction,s.receipt_id,s.requested_by,s.decided_by,s.source_partition,s.source_epoch,
 s.source_position,s.source_transaction_id,s.intent_digest,x.verification_intent_digest,x.original_source,
 x.recovery_transaction_id,p.epoch,p.position+1,x.recovery_receipt_key,x.recovery_digest
FROM saved s CROSS JOIN input x JOIN core.partition p ON p.partition_no=(SELECT partition FROM parameters) AND p.write_state='active'
RETURNING receipt_id;
