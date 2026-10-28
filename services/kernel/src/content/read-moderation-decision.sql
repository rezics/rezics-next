SELECT decision_id, target_kind, target_id, action, statement, decided_at
FROM content.moderation_decision
WHERE route = :route::integer AND decision_id = :decision_id::uuid;
