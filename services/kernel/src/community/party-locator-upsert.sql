INSERT INTO community.party_locator (route, account_id, kind, due_at, owner_route, owner_id, key)
VALUES (:route::integer, :account_id::uuid, :kind::text, :due_at::timestamptz,
        :owner_route::integer, :owner_id::uuid, :key::text)
ON CONFLICT DO NOTHING
RETURNING key;
