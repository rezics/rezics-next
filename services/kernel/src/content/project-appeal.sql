INSERT INTO content.moderation_appeal_board (route, board_id, appeal_id, created_at, pending)
VALUES (:route::integer, :board_id::uuid, :appeal_id::uuid, :created_at::timestamptz, :pending::boolean)
ON CONFLICT (route, board_id, appeal_id) DO UPDATE
SET pending = content.moderation_appeal_board.pending AND EXCLUDED.pending;
