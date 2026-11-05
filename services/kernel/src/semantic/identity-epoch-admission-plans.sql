SELECT * FROM semantic.identity_epoch_admission_plan WHERE partition_no=$1 AND job_id=$2 ORDER BY resource_home LIMIT 2;
