DELETE FROM content.report_reporter
WHERE route = :route::integer AND reporter_account_id = :actor_id::uuid
  AND report_id = ANY(:report_ids::uuid[])
RETURNING report_id;
