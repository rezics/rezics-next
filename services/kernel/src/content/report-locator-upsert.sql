INSERT INTO content.report_reporter(route, reporter_account_id, report_route, report_id)
VALUES (:route::integer, :actor_id::uuid, :report_route::integer, :report_id::uuid)
ON CONFLICT (route, reporter_account_id, report_id) DO NOTHING
RETURNING report_id;
