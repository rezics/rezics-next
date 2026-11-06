WITH parameters AS (SELECT $1::uuid job,$2::bigint epoch,$3::integer home)
UPDATE semantic.identity_epoch_job SET state='cancelled' WHERE partition_no=(SELECT home FROM parameters) AND job_id=(SELECT job FROM parameters) AND epoch=(SELECT epoch FROM parameters)
 AND state='cancelling' AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_plan WHERE partition_no=(SELECT home FROM parameters) AND job_id=(SELECT job FROM parameters) AND (closed_transaction_id IS NULL OR NOT released))
RETURNING job_id;
