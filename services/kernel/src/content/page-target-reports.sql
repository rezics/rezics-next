SELECT report_route, report_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.report_target
WHERE route = :route::integer AND target_kind = :target_kind::text AND target_id = :target_id::uuid
  AND (created_at, report_id) < (:created_at::timestamptz, :report_id::uuid)
ORDER BY report_target.created_at DESC, report_id DESC
LIMIT :limit::integer;
