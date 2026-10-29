SELECT kind, due_at::text AS due_at, owner_route, owner_id::text AS owner_id, key
FROM community.party_locator
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND (kind, due_at, owner_route, owner_id, key) >
      (:after_kind::text, :after_due::timestamptz, :after_route::integer, :after_owner::uuid, :after_key::text)
ORDER BY kind, due_at, owner_route, owner_id, key
LIMIT 50;
