INSERT INTO access.agent_identity_intent
(route,account_id,direction,receipt_id,agent_id,account_kind,catalogue_id,request_id,requested_by,
 decided_by,decision_route,decision_receipt_id,decision_epoch,decision_position,decision_transaction_id,pending_receipt_id,verification_receipt_id,
 disposition,reason,release,intent,intent_digest,source_partition,source_epoch,source_position,
 source_transaction_id,undo_job_id,undo_job_epoch,delivery_key,workflow_id,native_command_kind,native_receipt_key)
SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$26,$27,$28,$13,$14,$15,$16,$17,$18::jsonb,$19,
       p.partition_no,p.epoch,p.position+1,$20,$21,$22,$23,$24,$29,$30
FROM core.partition p WHERE p.partition_no=$25 AND p.write_state='active'
AND ($3='account-agent.verify' OR EXISTS (
  SELECT 1 FROM access.agent_identity_intent v
  WHERE v.route=$1 AND v.account_id=$2 AND v.direction='account-agent.verify' AND v.receipt_id=$14
    AND v.catalogue_id=$7 AND v.source_epoch=p.epoch AND v.intent_digest=$31
))
ON CONFLICT (route,account_id,direction,receipt_id) DO NOTHING
RETURNING receipt_id;
