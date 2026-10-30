INSERT INTO content.board_report_candidate
  (route, board_id, target_kind, target_id, report_route, report_id, created_at)
VALUES (:route::integer, :board_id::uuid, :target_kind::text, :target_id::uuid,
        :report_route::integer, :report_id::uuid, :created_at::timestamptz)
ON CONFLICT (route, board_id, report_id) DO NOTHING
RETURNING report_id;
