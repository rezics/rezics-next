SELECT job_id,epoch FROM semantic.identity_epoch_job
      WHERE receipt_key=$1 AND receipt=$2::jsonb;
