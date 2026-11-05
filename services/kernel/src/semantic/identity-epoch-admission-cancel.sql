UPDATE semantic.identity_epoch_job SET state='cancelling' WHERE partition_no=$3 AND job_id=$1 AND epoch=$2 AND state='preparing' RETURNING job_id;
