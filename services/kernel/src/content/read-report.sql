WITH input AS NOT MATERIALIZED (
  SELECT :include_private::boolean AS include_private,
         :owner_account_id::uuid AS owner_account_id
)
SELECT route, report_id, target_kind, target_id, revision_id,
       CASE WHEN input.include_private THEN reason END AS reason,
       CASE WHEN input.include_private THEN evidence END AS evidence,
       reporter_account_id,
       outcome,
       to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS resolved_at,
       recorded_transaction_id,
       to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
FROM content.report CROSS JOIN input
WHERE route = :route::integer AND report_id = :report_id::uuid
  AND (input.owner_account_id IS NULL OR reporter_account_id = input.owner_account_id);
