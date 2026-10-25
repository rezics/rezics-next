WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :resource_id::uuid AS resource_id, :action::text AS action
)
SELECT DISTINCT subject_id::text AS "organizationId"
FROM (
  SELECT subject_id FROM access.resource_grant g CROSS JOIN input i
  WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.action = i.action AND subject_role <> ''
  UNION
  SELECT subject_id FROM access.resource_denial g CROSS JOIN input i
  WHERE g.route = i.route AND g.resource_id = i.resource_id AND g.action = i.action AND subject_role <> ''
) candidates;
