DELETE FROM semantic.identity_scope_inverse
WHERE partition_no=$1 AND generation=$2 AND original=$3 AND source_partition=$4
  AND capture_id=$5 AND registration=$6::uuid AND source_key=$7
