SELECT i.* FROM semantic.identity_epoch_prearm_inverse i
WHERE i.partition_no=$1 AND i.generation=$2 AND
 ($3::uuid IS NULL OR (i.original,i.scope_key,i.registration)>($3,$4::text,$5::text))
ORDER BY i.original,i.scope_key,i.registration LIMIT 1;
