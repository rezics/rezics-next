SELECT original::text
FROM semantic.identity_epoch_original
WHERE partition_no=$1 AND generation=$2 AND terminal=$3 AND present
  AND original>coalesce($4::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
ORDER BY original LIMIT $5;
