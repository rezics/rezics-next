SELECT kind, count, source_epoch, source_position
FROM content.reaction_total
WHERE route = :route::integer AND target_id = :target_id::uuid;
