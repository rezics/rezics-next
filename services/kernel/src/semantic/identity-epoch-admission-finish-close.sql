WITH parameters AS (SELECT $1::uuid job,$2::bigint epoch,$3::integer home), closed AS (
 UPDATE semantic.identity_epoch_job SET state='cancelled' WHERE partition_no=(SELECT home FROM parameters) AND job_id=(SELECT job FROM parameters) AND epoch=(SELECT epoch FROM parameters)
 AND state='cancelling' AND NOT EXISTS(SELECT 1 FROM semantic.identity_epoch_admission_plan WHERE partition_no=(SELECT home FROM parameters) AND job_id=(SELECT job FROM parameters) AND closed_transaction_id IS NULL)
 RETURNING job_id
), released AS (DELETE FROM semantic.identity_epoch_input WHERE partition_no=(SELECT home FROM parameters) AND job_id IN (SELECT job_id FROM closed)),
 sources AS (DELETE FROM semantic.identity_epoch_admission_source WHERE partition_no=(SELECT home FROM parameters) AND job_id IN (SELECT job_id FROM closed))
SELECT job_id FROM closed;
