SELECT c.*, n.epoch AS native_epoch, n.position::text AS native_position, p.node AS owner_node
FROM semantic.identity_epoch_receipt_binding b
JOIN semantic.identity_epoch_receipt_claim c
  ON (c.partition_no,c.receipt_key,c.generation)=(b.partition_no,b.receipt_key,b.generation)
JOIN semantic.identity_epoch_receipt_claim_commit k
  ON (k.partition_no,k.receipt_key,k.generation,k.transaction_id)=
     (c.partition_no,c.receipt_key,c.generation,c.transaction_id)
JOIN semantic.identity_epoch_native_commit n
  ON (n.partition_no,n.transaction_id)=(c.partition_no,c.transaction_id)
  AND n.purpose='admission' AND n.xmin=k.xmin AND n.xmin=c.xmin
JOIN core.partition p ON p.partition_no=c.partition_no AND p.write_state='active'
  AND p.epoch=n.epoch AND p.position>=n.position AND n.position>0
WHERE b.partition_no=$1 AND b.receipt_key=$2 AND b.account_id=$3 AND b.state='accepted'
  AND b.intent_digest=c.intent_digest AND (b.accepted_job,b.accepted_epoch)=(c.job_id,c.job_epoch)
  AND NOT c.imported
FOR SHARE OF b;
