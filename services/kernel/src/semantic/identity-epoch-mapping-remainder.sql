SELECT original::text FROM semantic.identity_epoch_original
WHERE partition_no=$1 AND generation=$2 AND present AND original<>$3::uuid
ORDER BY original LIMIT 1;
