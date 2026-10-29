SELECT * FROM semantic.identity_epoch_admission_source WHERE partition_no=$1 AND job_id=$2 ORDER BY original LIMIT 2;
