SELECT e.at::text
FROM access.erasure e
JOIN access.account a ON a.route = e.route AND a.account_id = e.account_id
WHERE e.route = :route::integer AND e.account_id = :account_id::uuid
  AND a.state = 'deleted' AND a.authn_fenced;
