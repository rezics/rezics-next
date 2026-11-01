(SELECT report_route, report_id, target_kind, target_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.board_report_candidate
WHERE route = :route::integer AND board_id = :board_id::uuid
  AND NOT :oldest::boolean
  AND (created_at, report_id) < (:created_at::timestamptz, :report_id::uuid)
ORDER BY board_report_candidate.created_at DESC, report_id DESC
LIMIT :limit::integer)
UNION ALL
(SELECT report_route, report_id, target_kind, target_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.board_report_candidate
WHERE route = :route::integer AND board_id = :board_id::uuid
  AND :oldest::boolean
  AND (created_at, report_id) > (:created_at::timestamptz, :report_id::uuid)
ORDER BY board_report_candidate.created_at ASC, report_id ASC
LIMIT :limit::integer);
