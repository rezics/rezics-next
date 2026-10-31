SELECT realm_route, realm_id::text
FROM community.member_locator
WHERE route = :route::integer AND account_id = :account_id::uuid
  AND realm_id > COALESCE(:after::nullable(uuid), '00000000-0000-0000-0000-000000000000'::uuid)
ORDER BY realm_id
LIMIT 50;
