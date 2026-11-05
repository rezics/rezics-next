UPDATE library.native_public_output_receiving SET state=$3,receiving_epoch=receiving_epoch+1,transaction_id=$4
WHERE partition_no=$1 AND capture_id=$2 AND state='open' AND receiving_epoch=$5;
