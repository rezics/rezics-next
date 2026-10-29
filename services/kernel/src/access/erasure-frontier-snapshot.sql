UPDATE access.erasure SET frontier = (
  SELECT COALESCE(jsonb_agg(jsonb_build_object('partition', p.partition_no, 'position', p.position::text)), '[]'::jsonb)
  FROM core.partition p
  LEFT JOIN core.consumer_checkpoint c ON c.partition_no = p.partition_no AND c.consumer = 'effects'
  WHERE p.position > COALESCE(c.position, 0)
)
WHERE route = :route::integer AND account_id = :account_id::uuid AND frontier IS NULL;
