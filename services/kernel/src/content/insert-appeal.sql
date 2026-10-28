INSERT INTO content.moderation_appeal
  (route, appeal_id, decision_id, appellant_account_id, statement, thread_id, board_id, created_at)
VALUES (:route::integer, :appeal_id::uuid, :decision_id::uuid, :appellant::uuid, :statement::text,
        :thread_id::uuid, :board_id::uuid, :created_at::timestamptz)
ON CONFLICT (route, decision_id) DO NOTHING
RETURNING appeal_id;
