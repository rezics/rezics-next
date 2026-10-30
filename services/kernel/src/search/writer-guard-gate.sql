/* search:writer-guard:gate */
SELECT enrollment_generation, fence_generation, closed_token
FROM search.identity_writer_gate
WHERE partition_no=$1 AND physical_target=$2 AND consumer=$3
  AND incarnation=$4 AND owner_epoch=$5 AND write_alias=$6
FOR UPDATE;
