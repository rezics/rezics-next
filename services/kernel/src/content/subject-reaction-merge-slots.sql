SELECT target_id::text AS target_id, kind
FROM content.reaction
WHERE route = :route::integer
  AND actor_account_id = :actor_id::uuid
  AND target_kind = 'subject'
  AND target_id = ANY(ARRAY[:merged_id::uuid, :survivor_id::uuid]);
