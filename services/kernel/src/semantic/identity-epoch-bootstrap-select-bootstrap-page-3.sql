SELECT acknowledged FROM semantic.identity_epoch_bootstrap_page WHERE partition_no=$1 AND transaction_id=$2 FOR UPDATE;
