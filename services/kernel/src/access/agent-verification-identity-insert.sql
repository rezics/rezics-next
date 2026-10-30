INSERT INTO access.agent_identity_intent
(route,account_id,direction,receipt_id,agent_id,account_kind,catalogue_id,request_id,requested_by,
 decided_by,decision_route,decision_receipt_id,decision_epoch,decision_position,decision_transaction_id,pending_receipt_id,verification_receipt_id,
 disposition,reason,release,intent,intent_digest,source_partition,source_epoch,source_position,
 source_transaction_id,undo_job_id,undo_job_epoch,delivery_key,workflow_id)
SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$26,$27,$28,$13,$14,$15,$16,$17,$18::jsonb,$19,
       p.partition_no,p.epoch,p.position+1,$20,$21,$22,$23,$24
FROM core.partition p WHERE p.partition_no=$25 AND p.write_state='active'
ON CONFLICT (route,account_id,direction,receipt_id) DO NOTHING
RETURNING receipt_id;
