INSERT INTO semantic.identity_epoch_job(partition_no,job_id,epoch,intent,receipt_key,receipt,scope_digest,state,recorded_transaction_id)
VALUES($1,$2,$3,$4,$5,$6,$7,'preparing',$8);
