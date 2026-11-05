INSERT INTO semantic.identity_scope_attempt
(partition_no,source_key,scope_id,registration,job_id,job_epoch,attempt,state,transaction_id,revision)
VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) ON CONFLICT(partition_no,source_key,scope_id,registration,job_id,job_epoch)
DO UPDATE SET state=excluded.state,transaction_id=excluded.transaction_id,revision=excluded.revision;
