SELECT intent,receipt,state FROM semantic.identity_epoch_job
    WHERE job_id=$1 AND epoch=$2 AND partition_no=$3;
