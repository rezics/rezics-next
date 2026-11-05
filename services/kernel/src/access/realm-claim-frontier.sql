WITH input AS NOT MATERIALIZED (SELECT :at::timestamptz AS at)
SELECT f.version::text, f.processed_at <= input.at AND i.complete AND NOT EXISTS (
  SELECT 1 FROM access.current_resource_role_due d
  WHERE d.route = f.route AND d.resource_id = f.resource_id AND d.due_at <= input.at
  LIMIT 1
) AS ready
FROM access.current_resource_role_frontier f CROSS JOIN access.current_resource_role_install i CROSS JOIN input
WHERE f.route = :route::integer AND f.resource_id = :resource_id::uuid AND i.singleton
FOR UPDATE OF f;
