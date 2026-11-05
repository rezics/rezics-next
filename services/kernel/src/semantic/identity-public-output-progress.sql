SELECT version::text,after_key,exhausted,manifest_digest,raw_count::text,canonical_count::text,
 pending,closure_after::text
FROM semantic.identity_public_output_progress WHERE partition_no=$1 AND capture_id=$2 FOR UPDATE;
