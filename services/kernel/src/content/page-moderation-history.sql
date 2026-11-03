SELECT decision_id::text, target_kind, target_id::text,
       to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at
FROM content.moderation_decision_board
WHERE route = :route::integer AND board_id = :board_id::uuid
  AND (:target_kind::text = 'all' OR target_kind = :target_kind::text)
  AND (decided_at, decision_id) < (:after_decided_at::timestamptz, :after_decision_id::uuid)
ORDER BY decided_at DESC, decision_id DESC
LIMIT :limit::integer;
