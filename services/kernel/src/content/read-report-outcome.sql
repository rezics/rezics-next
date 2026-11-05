SELECT report_id, target_kind, target_id, reporter_account_id, outcome, decision_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS resolved_at
FROM content.report
WHERE route = :route::integer AND report_id = :report_id::uuid;
