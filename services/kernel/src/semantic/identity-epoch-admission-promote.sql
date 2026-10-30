WITH parameters AS (SELECT $1::uuid job,$2::bigint epoch)
UPDATE semantic.identity_epoch_job SET state='pending' WHERE partition_no=$3 AND job_id=(SELECT job FROM parameters) AND epoch=(SELECT epoch FROM parameters)
 AND state='preparing' AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_plan WHERE partition_no=$3 AND job_id=(SELECT job FROM parameters) AND acquired_transaction_id IS NULL)
RETURNING job_id;
