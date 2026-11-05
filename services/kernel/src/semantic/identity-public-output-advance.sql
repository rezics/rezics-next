UPDATE semantic.identity_public_output_progress SET version=version+1,after_key=$4::jsonb,exhausted=$5,
 manifest_digest=$6,raw_count=raw_count+$7,canonical_count=canonical_count+$8,pending=NULL,closure_after=0
WHERE partition_no=$1 AND capture_id=$2 AND version=$3;
