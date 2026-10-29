SELECT reporter_account_id, target_kind, target_id, revision_id
FROM content.report
WHERE route = :route::integer AND report_id = :report_id::uuid;
