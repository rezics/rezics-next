UPDATE semantic.identity_public_output_progress SET pending=$4::jsonb,closure_after=0
WHERE partition_no=$1 AND capture_id=$2 AND version=$3 AND pending IS NULL AND NOT exhausted;
