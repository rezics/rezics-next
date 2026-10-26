-- The ids read's public identity projection, restricted to active, unfenced speakers.
SELECT a.account_id::text AS id, a.kind, a.handle, a.display_name AS "displayName",
       'active'::text AS state, a.operator_account_id IS NOT NULL AS automated,
       a.operator_account_id::text AS "operatorId"
FROM unnest(:routes::integer[], :account_ids::uuid[]) WITH ORDINALITY
  AS requested(route, account_id, ordinal)
JOIN LATERAL (
  SELECT account_id, kind, handle, display_name, operator_account_id
  FROM access.account
  WHERE route = requested.route AND account_id = requested.account_id
    AND state = 'active' AND NOT authn_fenced
  LIMIT 1
) a ON true
ORDER BY requested.ordinal;
