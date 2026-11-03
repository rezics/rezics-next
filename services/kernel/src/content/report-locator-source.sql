SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at, reporter_account_id, target_kind, target_id, revision_id
FROM content.report
WHERE route = :route::integer AND report_id = :report_id::uuid;
