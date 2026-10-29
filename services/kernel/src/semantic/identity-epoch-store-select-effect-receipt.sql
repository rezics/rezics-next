SELECT 1 FROM semantic.identity_epoch_effect_receipt
        WHERE job_id=$1 AND step=$2 AND native_transaction_id IS NULL LIMIT 1;
