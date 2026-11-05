WITH input AS (
  SELECT :route::integer AS route, :board_id::uuid AS board_id,
         :after_decided_at::timestamptz AS after_decided_at, :after_decision_id::uuid AS after_decision_id
)
SELECT d.decision_id::text, d.target_kind, d.target_id::text,
       to_char(d.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at
FROM content.moderation_decision_board d CROSS JOIN input i
WHERE d.route = i.route AND d.board_id = i.board_id
  AND (d.decided_at, d.decision_id) < (i.after_decided_at, i.after_decision_id)
ORDER BY d.decided_at DESC, d.decision_id DESC
LIMIT :limit::integer;
