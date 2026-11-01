UPDATE semantic.identity_public_output_progress SET closure_after=$3
WHERE partition_no=$1 AND capture_id=$2;
