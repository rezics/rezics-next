SELECT c.kind = 'global' AS global, b.account_id::text AS account_id
FROM semantic.context c
LEFT JOIN access.governance_bootstrap b
  ON b.route = c.route AND b.resource_id = c.context_id
WHERE c.route = :route::integer AND c.context_id = :resource_id::uuid;
