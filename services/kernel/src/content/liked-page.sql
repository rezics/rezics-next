SELECT target_id AS "subjectId", kind
FROM content.reaction
WHERE route = :route::integer
  AND actor_account_id = :actor_id::uuid
  AND target_kind = 'subject'
  AND kind IN ('like', 'love')
  AND target_id > :after::uuid
ORDER BY target_id
LIMIT :limit::integer;
