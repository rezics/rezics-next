INSERT INTO semantic.identity_scope_prearm_receipt
(partition_no,source_key,scope_id,registration,job_id,job_epoch,directory_transaction,page_id,ordinal,disposition,transaction_id)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING;
