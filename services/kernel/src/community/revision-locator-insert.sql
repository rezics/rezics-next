INSERT INTO community.revision_locator (route, account_id, kind, owner_route, owner_id, revision_id)
VALUES (:route::integer, :account_id::uuid, :kind::text, :owner_route::integer, :owner_id::uuid, :revision_id::uuid)
ON CONFLICT DO NOTHING
RETURNING revision_id;
