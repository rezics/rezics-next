WITH parameters AS (SELECT $3::text AS digest)
SELECT c.generation::text,c.scope_digest,c.sources,c.receipt,c.intent,c.job_home,
       k.transaction_id AS binding_transaction_id
FROM semantic.identity_epoch_receipt_binding b
JOIN semantic.identity_epoch_receipt_claim c USING(partition_no,receipt_key,generation)
JOIN semantic.identity_epoch_receipt_claim_commit k USING(partition_no,receipt_key,generation)
JOIN semantic.identity_epoch_native_commit n ON n.partition_no=k.partition_no
  AND n.transaction_id=k.transaction_id AND n.purpose='admission' AND n.xmin=k.xmin
JOIN core.partition p ON p.partition_no=b.partition_no AND p.write_state='active'
  AND p.epoch=n.epoch AND p.position>=n.position
WHERE b.partition_no=$1 AND b.receipt_key=$2 AND b.state='accepted'
  AND b.intent_digest=(SELECT digest FROM parameters) AND c.intent_digest=(SELECT digest FROM parameters)
  AND c.job_id=$4 AND c.job_epoch=$5
  AND b.accepted_job=c.job_id AND b.accepted_epoch=c.job_epoch
FOR UPDATE OF b FOR SHARE OF c,k,n,p;
