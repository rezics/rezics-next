WITH input AS NOT MATERIALIZED (SELECT :due_at::timestamptz AS due_at)
DELETE FROM community.realm_ban
USING input i
WHERE route = :owner_route::integer AND realm_id = :owner_id::uuid AND account_id = :account_id::uuid
  AND valid @> i.due_at AND lower(valid) = i.due_at
RETURNING account_id;
