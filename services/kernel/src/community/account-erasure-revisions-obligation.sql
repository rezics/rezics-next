SELECT e.account_id
FROM access.erasure e
WHERE e.route = :route::integer AND e.account_id = :account_id::uuid
  AND e.version >= 1;
