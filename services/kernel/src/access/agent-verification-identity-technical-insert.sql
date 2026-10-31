WITH input AS (SELECT $7::integer AS partition_no)
INSERT INTO access.agent_identity_technical_source
 (route,account_id,direction,receipt_id,intent,source_digest,source_partition,source_epoch,source_position,
 source_transaction_id,accepted_job_id,accepted_job_epoch,binding_generation,binding_transaction_id,
 workflow_id,receiving_transaction_id,domain_generation,receiving_epoch,receiving_position)
SELECT $1,$2,$3,$4,$5::jsonb,$6,input.partition_no,$8,$9,$10,$11,$12,$13,$14,$15,$16,d.generation,p.epoch,p.position+1
FROM core.partition p JOIN input USING(partition_no)
CROSS JOIN core.history_family_domain d WHERE p.write_state='active' AND d.singleton
RETURNING *;
