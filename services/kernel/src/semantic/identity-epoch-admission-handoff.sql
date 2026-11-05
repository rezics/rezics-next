INSERT INTO semantic.identity_epoch_admission_handoff(partition_no,job_id,job_epoch,scope_digest,job_home,source_transaction_id,inputs)
VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(partition_no,job_id) DO NOTHING;
