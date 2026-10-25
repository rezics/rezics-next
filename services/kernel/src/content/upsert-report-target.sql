INSERT INTO content.report_target
  (route, target_kind, target_id, report_route, report_id, created_at)
VALUES (:route::integer, :target_kind::text, :target_id::uuid, :report_route::integer,
        :report_id::uuid, :created_at::timestamptz)
ON CONFLICT (route, target_kind, target_id, report_route, report_id) DO NOTHING
RETURNING report_id;
