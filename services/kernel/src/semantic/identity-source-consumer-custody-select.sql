SELECT r.erasure_key::text,r.binding_generation::text,r.transaction_id,r.owner_epoch,n.position::text
FROM semantic.identity_epoch_source_consumer_custody r
JOIN semantic.erasure_source_commit n ON n.partition_no=r.partition_no AND n.transaction_id=r.transaction_id
  AND n.epoch=r.owner_epoch AND n.xmin=r.xmin
JOIN core.partition p ON p.partition_no=r.partition_no AND p.write_state='active'
  AND p.epoch=r.owner_epoch AND p.position>=n.position
JOIN semantic.identity_epoch_receipt_binding b ON b.partition_no=r.partition_no
  AND b.receipt_key=r.receipt_key AND b.generation=r.binding_generation
  AND b.intent_digest=r.source_digest AND b.state='accepted'
  AND b.accepted_job=r.job_id AND b.accepted_epoch=r.job_epoch
JOIN semantic.identity_epoch_receipt_claim c ON c.partition_no=b.partition_no
  AND c.receipt_key=b.receipt_key AND c.generation=b.generation
  AND c.scope_digest=r.scope_digest AND c.job_id=r.job_id AND c.job_epoch=r.job_epoch
JOIN semantic.identity_epoch_receipt_claim_commit k ON k.partition_no=c.partition_no
  AND k.receipt_key=c.receipt_key AND k.generation=c.generation AND k.transaction_id=r.binding_transaction_id
WHERE r.partition_no=$1 AND r.receipt_key=$2 AND r.source_digest=$3 AND r.source_epoch=$4
  AND r.source_position=$5 AND r.source_transaction_id=$6 AND r.job_id=$7 AND r.job_epoch=$8
  AND r.barrier_account_id=$9 AND r.barrier_account_route=$10 AND r.barrier_version=$11
  AND r.barrier_at=$12::timestamptz AND r.erased_role=$13
FOR SHARE OF r,n,p,b,c,k;
