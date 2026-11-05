SELECT decision_id, target_kind, target_id, decided_at
FROM content.moderation_decision
WHERE route = :route::integer AND target_kind = :target_kind::text
  AND target_id = :target_id::uuid AND security_revision = :security_revision::bigint;
