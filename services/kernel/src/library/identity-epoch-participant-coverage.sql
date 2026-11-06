INSERT INTO library.identity_epoch_coverage
 (partition_no,job_id,job_epoch,transaction_id,affected,exhausted)
VALUES($1,$2,$3,$4,$5,true)
ON CONFLICT (partition_no,job_id,job_epoch) DO UPDATE
 SET exhausted=true
 WHERE library.identity_epoch_coverage.affected=EXCLUDED.affected
RETURNING affected;
