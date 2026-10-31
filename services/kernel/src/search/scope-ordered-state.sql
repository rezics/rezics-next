SELECT ordered_state FROM search.scope_preparation
WHERE partition_no=0 AND prefix=:prefix::text AND scope_id=:scope::text;
