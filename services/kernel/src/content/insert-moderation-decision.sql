INSERT INTO content.moderation_decision
  (route, decision_id, target_kind, target_id, action, statement, decider_account_id, security_revision, decided_at)
VALUES (:route::integer, :decision_id::uuid, :target_kind::text, :target_id::uuid,
        'takedown', :statement::text, :decider_account_id::uuid, :security_revision::bigint, :decided_at::timestamptz);
