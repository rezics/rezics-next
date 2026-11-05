UPDATE content.report
SET evidence = NULL, reporter_account_id = NULL, reporter_erased = true
WHERE route = :route::integer AND report_id = :report_id::uuid
  AND reporter_account_id = :actor_id::uuid
RETURNING report_id;
