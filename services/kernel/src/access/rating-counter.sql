SELECT controller_id AS "controllerId"
FROM access.rating_counter_controller
WHERE route = :route::integer AND account_id = :account_id::uuid AND effective_at <= :at::timestamptz
ORDER BY effective_at DESC
LIMIT 1;
