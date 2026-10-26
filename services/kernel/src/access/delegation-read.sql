SELECT p.valid::text AS valid
FROM access.principal_assignment p
JOIN access.account a ON a.route = p.route AND a.account_id = p.principal_id
WHERE p.route = :route AND p.principal_id = :principal_id AND p.request_id = :request_id
  AND p.creator_principal_id = p.principal_id AND p.assigned_actor_id = :actor_id AND p.revoked_at IS NULL AND p.valid @> :at::timestamptz
  AND a.kind = 'actor' AND a.state = 'active' AND NOT a.authn_fenced;
