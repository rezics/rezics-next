WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route)
SELECT c.kind = 'global' AS global, b.resource_id IS NOT NULL AS bootstrapped, b.account_id::text AS account_id,
       EXISTS (SELECT 1 FROM access.standing_parent_installation s
         WHERE s.route = i.route AND s.resource_id = c.context_id
           AND s.actions = ARRAY['organization:create']::text[]) AS organization_installed
FROM semantic.context c CROSS JOIN input i
LEFT JOIN access.governance_bootstrap b
  ON b.route = i.route AND b.resource_id = c.context_id
WHERE c.route = i.route AND c.context_id = :resource_id::uuid;
