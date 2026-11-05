SELECT appeal_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.moderation_appeal_board
WHERE route = :route::integer AND board_id = :id::uuid AND pending
  AND (created_at, appeal_id) < (:created_at::timestamptz, :appeal_id::uuid)
ORDER BY moderation_appeal_board.created_at DESC, appeal_id DESC
LIMIT :limit::integer;
