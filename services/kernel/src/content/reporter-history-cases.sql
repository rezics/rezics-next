-- Every supplied key is a separate exact native case probe. Ownership remains a
-- source predicate, including on a stale or malicious reporter-home locator.
SELECT r.route, r.report_id, r.target_kind, r.target_id, r.revision_id,
       r.reason, r.evidence, r.reporter_account_id, r.recorded_transaction_id,
       r.outcome,
       to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       to_char(r.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS resolved_at
FROM jsonb_to_recordset(:keys::jsonb) AS k(route integer, id uuid)
CROSS JOIN LATERAL (
  SELECT r.* FROM content.report r
  WHERE r.route = k.route AND r.report_id = k.id AND r.reporter_account_id = :reporter::uuid
  LIMIT 1
) r;
