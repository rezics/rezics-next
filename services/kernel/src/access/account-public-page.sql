SELECT a.account_id::text AS id,
       CASE WHEN a.state = 'deleted' THEN NULL ELSE a.handle END AS handle,
       CASE WHEN a.state = 'deleted' THEN NULL ELSE a.display_name END AS "displayName",
       CASE WHEN a.state = 'deleted' THEN 'deleted' ELSE 'active' END AS state
FROM unnest(:account_ids::uuid[]) WITH ORDINALITY
  AS requested(account_id, ordinal)
JOIN LATERAL (
  SELECT account_id, handle, display_name, state
  FROM access.account
  WHERE route = :route::integer AND account_id = requested.account_id AND state <> 'pending'
  LIMIT 1
) a ON true
ORDER BY requested.ordinal;
