SELECT original::text,terminal::text FROM semantic.identity_epoch_original
      WHERE partition_no=$5 AND generation=$1 AND terminal=$4 AND present AND original>coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
      ORDER BY original LIMIT $3;
