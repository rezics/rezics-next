UPDATE semantic.identity_epoch_bootstrap_page SET acknowledged=true WHERE partition_no=$1 AND transaction_id=$2;
