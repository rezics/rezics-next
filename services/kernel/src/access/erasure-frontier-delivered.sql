UPDATE access.erasure e
SET workflow_until = ceil(extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND frontier IS NOT NULL AND workflow_until IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(e.frontier) f
    WHERE NOT EXISTS (
      SELECT 1 FROM core.consumer_checkpoint c
      WHERE c.partition_no = (f->>'partition')::integer AND c.consumer = 'effects'
        AND c.position >= (f->>'position')::bigint
    )
  )
RETURNING workflow_until;
