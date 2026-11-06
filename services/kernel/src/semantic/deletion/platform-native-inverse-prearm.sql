DELETE FROM semantic.identity_epoch_prearm_inverse
WHERE partition_no=$1 AND generation=$2 AND original=$3 AND source_partition=$4
  AND capture_id=$5::text AND registration=$6 AND scope_key=$7
