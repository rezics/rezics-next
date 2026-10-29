SELECT target_id, target_kind, target_route
FROM content.reaction
WHERE route = :route::integer AND actor_account_id = :actor_id::uuid
  AND target_id > :after::uuid
ORDER BY target_id
LIMIT 50;
