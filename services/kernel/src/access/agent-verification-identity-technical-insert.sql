WITH input AS (
 SELECT $1::integer AS route,$2::uuid AS account_id,$3::text AS direction,$4::uuid AS receipt_id,
  $6::text AS source_digest,$7::integer AS partition_no,$8::integer AS source_epoch,
  $9::bigint AS source_position,$10::uuid AS source_transaction_id
)
INSERT INTO access.agent_identity_technical_source
 (route,account_id,direction,receipt_id,intent,source_digest,source_partition,source_epoch,source_position,
 source_transaction_id,accepted_job_id,accepted_job_epoch,binding_generation,binding_transaction_id,
 workflow_id,receiving_transaction_id,domain_generation,receiving_epoch,receiving_position)
SELECT input.route,input.account_id,input.direction,input.receipt_id,$5::jsonb,input.source_digest,
 input.partition_no,input.source_epoch,input.source_position,input.source_transaction_id,
 $11,$12,$13,$14,$15,$16,i.domain_generation,p.epoch,p.position+1
FROM core.partition p JOIN input USING(partition_no)
JOIN core.agent_identity_inventory i ON i.partition_no=input.partition_no
 AND i.source_route=input.route AND i.source_account_id=input.account_id
 AND i.source_direction=input.direction AND i.source_receipt_id=input.receipt_id
CROSS JOIN core.history_family_domain d
WHERE p.write_state='active' AND d.singleton
 AND i.state='sealed' AND i.producer_version=1 AND i.conversion_coverage='native-receipt-outbox/v1'
 AND i.native_writer_state='closed' AND i.receiver_epoch=p.epoch AND i.domain_generation=d.generation
 AND (i.source_digest,i.source_epoch,i.source_position,i.source_transaction_id)=
  (input.source_digest,input.source_epoch,input.source_position,input.source_transaction_id)
FOR SHARE OF i,p,d
RETURNING *;
