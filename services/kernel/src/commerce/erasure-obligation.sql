SELECT e.version, e.at::text AS at FROM access.erasure e
WHERE e.route = :route::integer AND e.account_id = :account_id::uuid;
