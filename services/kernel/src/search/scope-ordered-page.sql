SELECT hit FROM search.scope_preparation_ordered
WHERE partition_no=0 AND prefix=:prefix::text AND scope_id=:scope::text
  AND (count_key,name_key,subject)>(:count_key::integer,:name_key::bytea,:subject::uuid)
ORDER BY count_key,name_key,subject LIMIT :size::integer;
