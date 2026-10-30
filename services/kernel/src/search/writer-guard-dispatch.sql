/* search:writer-guard:dispatch */
UPDATE search.identity_writer SET dispatch_state='dispatched'
WHERE partition_no=$1 AND physical_target=$2 AND incarnation=$3 AND owner_epoch=$4
  AND writer_token=$5 AND original_id=ANY($6::uuid[]) AND dispatch_state='enrolled'
RETURNING original_id;
