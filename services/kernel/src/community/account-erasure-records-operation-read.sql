SELECT creation_idempotency_key, requested_at::text AS requested_at
FROM community.realm_membership_operation
WHERE route = :owner_route::integer AND operation_id = :owner_id::uuid;
