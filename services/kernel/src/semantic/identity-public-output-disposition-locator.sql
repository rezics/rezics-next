SELECT native_epoch,native_position::text,transaction_id::text,kind FROM semantic.identity_public_output_disposition
WHERE partition_no=$1 AND capture_id=$2;
