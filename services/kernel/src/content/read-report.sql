WITH input AS NOT MATERIALIZED (SELECT :include_private::boolean AS include_private)
SELECT route, report_id, target_kind, target_id, revision_id,
       CASE WHEN input.include_private THEN reason END AS reason,
       CASE WHEN input.include_private THEN evidence END AS evidence,
       CASE WHEN input.include_private THEN reporter_account_id END AS reporter_account_id,
       outcome,
       to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS resolved_at,
       recorded_transaction_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.report CROSS JOIN input
WHERE route = :route::integer AND report_id = :report_id::uuid;
