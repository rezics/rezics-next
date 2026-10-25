SELECT p.valid::text AS valid, a.account_id::text AS "accountId", a.kind, a.state, a.authn_fenced AS fenced,
       a.operator_account_id::text AS "operatorAccountId"
FROM access.principal_assignment p
JOIN access.account a ON a.route = p.route AND a.account_id = p.principal_id
WHERE p.route = :route AND p.principal_id = :principal_id AND p.request_id = :request_id
  AND p.assigned_actor_id = :actor_id AND p.valid @> :at::timestamptz;
