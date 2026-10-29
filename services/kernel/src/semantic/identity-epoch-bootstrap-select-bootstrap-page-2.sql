SELECT 1 FROM semantic.identity_epoch_bootstrap_page WHERE partition_no=$1 AND NOT acknowledged LIMIT 1;
