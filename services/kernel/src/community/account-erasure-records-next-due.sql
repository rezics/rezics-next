SELECT due_at::text AS due_at FROM community.party_locator
WHERE route = :route::integer AND account_id = :account_id::uuid AND kind = 'ban_actor'
ORDER BY due_at, owner_route, owner_id, key LIMIT 1;
