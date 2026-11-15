SELECT version::text,exhausted FROM semantic.identity_public_output_progress
WHERE partition_no=$1 AND capture_id=$2;
