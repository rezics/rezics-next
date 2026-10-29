UPDATE semantic.identity_epoch_job SET state='published' WHERE partition_no=$1 AND job_id=$2;
