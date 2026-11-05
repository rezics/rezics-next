WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route, :account_id::uuid AS account_id)
SELECT EXISTS (
  SELECT 1 FROM access.lifecycle_coordination c WHERE c.route = i.route AND c.account_id = i.account_id
) AS held,
EXISTS (
  SELECT 1 FROM access.organization_member m
  WHERE m.route = i.route AND m.organization_id = i.account_id AND m.role = 'owner' AND m.valid @> :at::timestamptz
) AS owners
FROM input i;
