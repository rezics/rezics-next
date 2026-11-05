SELECT c.*,b.state,k.transaction_id AS binding_transaction_id,n.epoch AS binding_epoch,n.position AS binding_position
FROM semantic.identity_epoch_receipt_binding b
JOIN semantic.identity_epoch_receipt_claim c ON (c.partition_no,c.receipt_key,c.generation)=(b.partition_no,b.receipt_key,b.generation)
LEFT JOIN semantic.identity_epoch_receipt_claim_commit k ON (k.partition_no,k.receipt_key,k.generation)=(c.partition_no,c.receipt_key,c.generation)
LEFT JOIN semantic.identity_epoch_native_commit n ON (n.partition_no,n.transaction_id)=(k.partition_no,k.transaction_id)
 AND n.purpose='admission' AND n.xmin=k.xmin
JOIN core.partition p ON p.partition_no=c.partition_no AND p.write_state='active'
WHERE b.partition_no=$1 AND b.receipt_key=$2
 AND (k.transaction_id IS NULL OR (p.epoch=n.epoch AND p.position>=n.position)) FOR UPDATE OF b;
