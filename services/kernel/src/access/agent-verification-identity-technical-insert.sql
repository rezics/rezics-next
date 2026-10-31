INSERT INTO access.agent_identity_technical_source
 (route,account_id,direction,receipt_id,intent,source_digest,source_partition,source_epoch,source_position,
 source_transaction_id,accepted_job_id,accepted_job_epoch,binding_generation,binding_transaction_id,
 workflow_id,receiving_transaction_id,receiving_epoch,receiving_position)
SELECT $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,p.epoch,p.position+1
FROM core.partition p WHERE p.partition_no=$7 AND p.write_state='active'
RETURNING *;
