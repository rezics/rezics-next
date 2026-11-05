INSERT INTO content.report_reporter(route, reporter_account_id, report_route, report_id, created_at)
VALUES (:route::integer, :actor_id::uuid, :report_route::integer, :report_id::uuid, :created_at::timestamptz)
ON CONFLICT (route, reporter_account_id, report_id) DO UPDATE
SET created_at = EXCLUDED.created_at
WHERE content.report_reporter.created_at IS DISTINCT FROM EXCLUDED.created_at
RETURNING report_id;
