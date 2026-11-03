INSERT INTO content.moderation_decision
  (route, decision_id, target_kind, target_id, action, statement, decider_account_id, security_revision, decided_at, recorded_transaction_id, board_id)
VALUES (:route::integer, :decision_id::uuid, :target_kind::text, :target_id::uuid,
        'takedown', :statement::text, :decider_account_id::uuid, :security_revision::bigint, :decided_at::timestamptz,
        :recorded_transaction_id::uuid, :board_id::nullable(uuid));
