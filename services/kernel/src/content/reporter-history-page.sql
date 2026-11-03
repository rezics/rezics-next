SELECT report_route, report_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.report_reporter
WHERE route = :route::integer AND reporter_account_id = :reporter::uuid
  AND created_at IS NOT NULL
  AND (created_at, report_id) < (:at::timestamptz, :id::uuid)
ORDER BY created_at DESC, report_id DESC
LIMIT 21;
