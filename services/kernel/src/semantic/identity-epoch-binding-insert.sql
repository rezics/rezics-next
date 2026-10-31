WITH parameters AS (SELECT $3::text p3,$11::uuid p11), claimed AS (
 INSERT INTO semantic.identity_epoch_receipt_binding(partition_no,receipt_key,intent_digest,generation,state,account_id,
 consumer_undo_generation,consumer_undo_transaction_id)
 VALUES($1,$2,(SELECT p3 FROM parameters),1,'pending',$12,0,(SELECT p11 FROM parameters))
 ON CONFLICT(partition_no,receipt_key) DO UPDATE SET generation=semantic.identity_epoch_receipt_binding.generation+1,state='pending',
 accepted_job=NULL,accepted_epoch=NULL,consumer_undo_generation=0,
 consumer_undo_transaction_id=(SELECT p11 FROM parameters)
 WHERE semantic.identity_epoch_receipt_binding.state='not-applied'
 AND semantic.identity_epoch_receipt_binding.intent_digest=excluded.intent_digest
 RETURNING partition_no,receipt_key,generation
), saved AS (
 INSERT INTO semantic.identity_epoch_receipt_claim
 (partition_no,receipt_key,generation,intent_digest,receipt,intent,job_id,job_home,job_epoch,scope_digest,sources,transaction_id)
 SELECT partition_no,receipt_key,generation,(SELECT p3 FROM parameters),$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10::jsonb,
 (SELECT p11 FROM parameters) FROM claimed
 RETURNING partition_no,receipt_key,generation,transaction_id
)
INSERT INTO semantic.identity_epoch_receipt_claim_commit SELECT * FROM saved;
