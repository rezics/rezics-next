SELECT a.*, d.target_kind, d.target_id, d.decider_account_id
FROM content.moderation_appeal a
JOIN content.moderation_decision d ON d.route = a.route AND d.decision_id = a.decision_id
WHERE a.route = :route::integer AND a.appeal_id = :appeal_id::uuid;
