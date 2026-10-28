SELECT d.decision_id, d.target_kind, d.target_id, d.action, d.statement, d.decided_at, d.decider_account_id,
       a.appeal_id, a.outcome, a.resolver_statement, a.resolved_at
FROM content.moderation_decision d
LEFT JOIN content.moderation_appeal a ON a.route = d.route AND a.decision_id = d.decision_id
WHERE d.route = :route::integer AND d.decision_id = :decision_id::uuid;
