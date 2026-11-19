SELECT scope_digest,state FROM semantic.identity_epoch_job
        WHERE partition_no=$3 AND job_id=$1 AND epoch=$2 AND state IN ('pending','published') FOR UPDATE;
