WITH claimed AS (
 INSERT INTO semantic.identity_epoch_receipt_binding(partition_no,receipt_key,intent_digest,generation,state,account_id)
 VALUES($1,$2,$3,1,'pending',$12)
 ON CONFLICT(partition_no,receipt_key) DO UPDATE SET generation=semantic.identity_epoch_receipt_binding.generation+1,state='pending'
 WHERE semantic.identity_epoch_receipt_binding.state='not-applied'
 AND semantic.identity_epoch_receipt_binding.intent_digest=excluded.intent_digest
 RETURNING partition_no,receipt_key,generation
), saved AS (
 INSERT INTO semantic.identity_epoch_receipt_claim
 (partition_no,receipt_key,generation,intent_digest,receipt,intent,job_id,job_home,job_epoch,scope_digest,sources,transaction_id)
 SELECT partition_no,receipt_key,generation,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11 FROM claimed
 RETURNING partition_no,receipt_key,generation,transaction_id
)
INSERT INTO semantic.identity_epoch_receipt_claim_commit SELECT * FROM saved;
