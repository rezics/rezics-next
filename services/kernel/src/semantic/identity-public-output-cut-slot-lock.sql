SELECT generation::text,terminal::text,released FROM semantic.identity_public_output_subject_slot
WHERE partition_no=$1 AND capture_partition=$2 AND capture_id=$3 AND original=$4 FOR UPDATE;
