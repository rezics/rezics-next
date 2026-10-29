DELETE FROM community.realm_ban
WHERE route = :owner_route::integer AND realm_id = :owner_id::uuid AND account_id = :account_id::uuid
  AND valid @> :due_at::timestamptz AND lower(valid) = :due_at::timestamptz
RETURNING account_id;
