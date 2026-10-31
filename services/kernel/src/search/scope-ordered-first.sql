SELECT hit FROM search.scope_preparation_ordered
WHERE partition_no=0 AND prefix=:prefix::text AND scope_id=:scope::text
ORDER BY count_key,name_key,subject LIMIT :size::integer;
