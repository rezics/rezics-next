SELECT to_char(after_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS after_at, after_id, done
FROM content.report_outcome_work
WHERE route = :route::integer AND decision_id = :decision_id::uuid;
