WITH input AS (SELECT $1::integer home,$2::uuid generation,$3::uuid after_original,
 $4::text after_scope,$5::text after_registration)
SELECT i.* FROM semantic.identity_epoch_prearm_inverse i
WHERE i.partition_no=(SELECT home FROM input) AND i.generation=(SELECT generation FROM input)
 AND ((SELECT after_original FROM input) IS NULL OR (i.original,i.scope_key,i.registration)>
  ((SELECT after_original FROM input),(SELECT after_scope FROM input),(SELECT after_registration FROM input)))
ORDER BY i.original,i.scope_key,i.registration LIMIT 1;
