SELECT kind, realm_id::text, member_account_id::text, initiator_account_id::text,
       reservation_id::text, ban_id::text, creation_idempotency_key,
       actor_client_id
FROM community.realm_membership_operation
WHERE route = :owner_route::integer AND operation_id = :owner_id::uuid;
