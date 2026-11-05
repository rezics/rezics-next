SELECT 1 FROM semantic.identity_epoch_effect_receipt WHERE partition_no=$1 AND job_id=$2 AND native_transaction_id IS NULL LIMIT 1;
