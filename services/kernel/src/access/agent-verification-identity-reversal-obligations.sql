-- Exact same-home obligation points, never job/holder/history enumeration.
SELECT b.consumer_undo_generation::text AS undo_generation,
 d.generation::text AS restore_generation
FROM semantic.identity_epoch_receipt_binding b
JOIN semantic.identity_epoch_native_commit u ON u.partition_no=b.partition_no
 AND u.transaction_id=b.consumer_undo_transaction_id AND u.purpose='admission'
JOIN core.partition p ON p.partition_no=b.partition_no AND p.write_state='active'
 AND p.moved_to IS NULL AND p.epoch=u.epoch AND p.position>=u.position
CROSS JOIN core.history_family_domain d
WHERE b.partition_no=$1 AND b.receipt_key=$2 AND b.generation=$3
 AND b.consumer_undo_generation IS NOT NULL AND d.singleton AND p.epoch=$5
 AND EXISTS(SELECT 1 FROM semantic.identity_epoch_receipt_claim_commit k
  WHERE k.partition_no=b.partition_no AND k.receipt_key=b.receipt_key
   AND k.generation=b.generation AND k.transaction_id=$4)
FOR UPDATE OF b FOR SHARE OF u,p,d;
