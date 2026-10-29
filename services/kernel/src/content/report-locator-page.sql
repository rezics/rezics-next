SELECT report_id, report_route
FROM content.report_reporter
WHERE route = :route::integer AND reporter_account_id = :actor_id::uuid
  AND report_id > :after::uuid
ORDER BY report_id
LIMIT 50;
