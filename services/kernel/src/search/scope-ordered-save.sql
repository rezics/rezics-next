WITH advance AS (
  UPDATE search.scope_preparation SET ordered_state=:ordered_state::jsonb,
    frontier=:frontier::jsonb,observation=:observation::jsonb,
    state=:state::text,revision=revision+1,lease_until=0,due_at=:due::bigint
  WHERE partition_no=0 AND prefix=:prefix::text AND scope_id=:scope::text
    AND revision=:revision::bigint AND state='capture'
  RETURNING scope_id,prefix
), rows AS (
  INSERT INTO search.scope_preparation_ordered(partition_no,prefix,scope_id,subject,count_key,name_key,hit)
  SELECT 0,advance.prefix,advance.scope_id,k.subject,k.count_key,k.name_key,k.hit
  FROM advance CROSS JOIN unnest(:subjects::uuid[],:counts::integer[],:names::bytea[],:hits::bytea[])
    AS k(subject,count_key,name_key,hit)
  ON CONFLICT (partition_no,prefix,scope_id,subject) DO NOTHING
  RETURNING subject
)
SELECT scope_id FROM advance;
