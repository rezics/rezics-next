UPDATE library.native_public_output_hold SET consumed_by=$3
WHERE partition_no=$1 AND hold_id=$2 AND consumed_by IS NULL;
