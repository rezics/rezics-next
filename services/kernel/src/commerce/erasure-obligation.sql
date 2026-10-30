SELECT e.version FROM access.erasure e
WHERE e.route = :route::integer AND e.account_id = :account_id::uuid;
