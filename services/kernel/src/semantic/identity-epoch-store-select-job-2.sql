SELECT job_id,epoch FROM semantic.identity_epoch_job
      WHERE partition_no=$3 AND receipt_key=$1 AND receipt=$2::jsonb;
