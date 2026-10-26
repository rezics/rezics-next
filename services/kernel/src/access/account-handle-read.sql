SELECT account_id AS "accountId"
FROM access.handle_claim
WHERE route = :route::integer AND normalized_handle = :handle::text AND state = 'active';
