INSERT INTO content.report_outcome_delivery (route, recipient_id, report_id)
VALUES (:route::integer, :recipient_id::uuid, :report_id::uuid)
ON CONFLICT DO NOTHING
RETURNING report_id;
