INSERT INTO content.moderation_decision_board
  (route, board_id, decision_id, target_kind, target_id, decided_at)
VALUES
  (:route::integer, :board_id::uuid, :decision_id::uuid, :target_kind::text, :target_id::uuid, :decided_at::timestamptz)
ON CONFLICT (route, board_id, decision_id) DO UPDATE
SET target_kind = EXCLUDED.target_kind,
    target_id = EXCLUDED.target_id,
    decided_at = EXCLUDED.decided_at;
