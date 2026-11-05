SELECT consumer_terminal_custody
FROM semantic.identity_epoch_receipt_binding
WHERE partition_no=$1 AND receipt_key=$2 FOR UPDATE;
