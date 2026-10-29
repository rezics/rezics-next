SELECT version, at::text
FROM access.erasure
WHERE route = :route::integer AND account_id = :account_id::uuid
FOR UPDATE;
