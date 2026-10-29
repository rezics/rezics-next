SELECT job_id,epoch FROM semantic.identity_epoch_job WHERE partition_no=$1 AND state IN ('preparing','cancelling') LIMIT 1;
