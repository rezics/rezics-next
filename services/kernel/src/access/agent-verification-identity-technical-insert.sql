WITH input AS (SELECT $7::integer AS partition_no)
INSERT INTO access.agent_identity_technical_source
 (route,account_id,direction,receipt_id,intent,source_digest,source_partition,source_epoch,source_position,
 source_transaction_id,accepted_job_id,accepted_job_epoch,binding_generation,binding_transaction_id,
 workflow_id,receiving_transaction_id,domain_generation,receiving_epoch,receiving_position)
SELECT $1,$2,$3,$4,$5::jsonb,$6,input.partition_no,$8,$9,$10,$11,$12,$13,$14,$15,$16,i.domain_generation,p.epoch,p.position+1
FROM core.partition p JOIN input USING(partition_no)
JOIN core.agent_identity_inventory i ON i.partition_no=input.partition_no
 AND i.source_route=$1 AND i.source_account_id=$2 AND i.source_direction=$3 AND i.source_receipt_id=$4
CROSS JOIN core.history_family_domain d
WHERE p.write_state='active' AND d.singleton
 AND i.state='sealed' AND i.producer_version=1 AND i.conversion_coverage='native-receipt-outbox/v1'
 AND i.native_writer_state='closed' AND i.receiver_epoch=p.epoch AND i.domain_generation=d.generation
 AND (i.source_digest,i.source_epoch,i.source_position,i.source_transaction_id)=($6,$8,$9,$10)
FOR SHARE OF i,p,d
RETURNING *;
