SELECT a.account_id::text AS id,
       a.kind,
       CASE WHEN a.state = 'deleted' THEN NULL ELSE a.handle END AS handle,
       CASE WHEN a.state = 'deleted' THEN NULL ELSE a.display_name END AS "displayName",
       CASE WHEN a.state = 'deleted' THEN 'deleted' ELSE 'active' END AS state,
       a.state <> 'deleted' AND a.operator_account_id IS NOT NULL AS automated,
       CASE WHEN a.state = 'deleted' THEN NULL ELSE a.operator_account_id::text END AS "operatorId"
FROM unnest(:account_ids::uuid[]) WITH ORDINALITY
  AS requested(account_id, ordinal)
JOIN LATERAL (
  SELECT account_id, kind, handle, display_name, state, operator_account_id
  FROM access.account
  WHERE route = :route::integer AND account_id = requested.account_id AND state <> 'pending'
  LIMIT 1
) a ON true
ORDER BY requested.ordinal;
