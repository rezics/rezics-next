INSERT INTO content.catalogue_report_candidate (route, report_route, report_id, subject_id, target_kind, created_at)
VALUES (0, :report_route::integer, :report_id::uuid, :subject_id::uuid, :target_kind::text, :created_at::timestamptz)
ON CONFLICT (route, report_id) DO NOTHING RETURNING report_id;
