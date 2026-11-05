SELECT kind, due_at::text AS due_at, owner_route, owner_id::text AS owner_id, key
FROM community.party_locator
WHERE route = :route::integer AND account_id = :account_id::uuid AND kind = 'ban_actor'
  AND due_at <= :as_of::timestamptz
  AND (due_at, owner_route, owner_id, key) >
      (:after_due::timestamptz, :after_route::integer, :after_owner::uuid, :after_key::text)
ORDER BY due_at, owner_route, owner_id, key
LIMIT 50;
