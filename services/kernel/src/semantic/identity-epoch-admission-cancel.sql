UPDATE semantic.identity_epoch_job SET state='cancelling' WHERE job_id=$1 AND epoch=$2 AND state='preparing' RETURNING job_id;
