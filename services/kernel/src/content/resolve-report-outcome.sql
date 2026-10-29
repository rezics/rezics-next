UPDATE content.report
SET outcome = :outcome::text, resolved_at = :resolved_at::timestamptz,
    resolved_by = :resolved_by::uuid, decision_id = :decision_id::nullable(uuid)
WHERE route = :route::integer AND report_id = :report_id::uuid AND outcome IS NULL
RETURNING report_id;
