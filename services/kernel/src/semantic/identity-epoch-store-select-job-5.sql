SELECT scope_digest FROM semantic.identity_epoch_job
        WHERE partition_no=$3 AND job_id=$1 AND epoch=$2 AND state='pending' FOR UPDATE;
