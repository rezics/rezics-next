INSERT INTO community.member_locator (route, account_id, realm_route, realm_id)
VALUES (:route::integer, :account_id::uuid, :realm_route::integer, :realm_id::uuid)
ON CONFLICT DO NOTHING
RETURNING realm_id::text;
