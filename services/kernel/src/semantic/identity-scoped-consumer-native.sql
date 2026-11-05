SELECT purpose,epoch,position::text FROM semantic.identity_epoch_native_commit
WHERE partition_no=$1 AND transaction_id=$2;
