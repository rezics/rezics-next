SELECT native_transaction_id FROM semantic.identity_epoch_bootstrap_custody
        WHERE partition_no=$1 AND source_partition=$2 AND source_generation=$3 AND stage=$4;
