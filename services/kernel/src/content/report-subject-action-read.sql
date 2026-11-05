SELECT action_id, to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at
FROM content.subject_report_action
WHERE route = :route::integer AND subject_id = :subject_id::uuid;
