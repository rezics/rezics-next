SELECT a.account_id::text AS id,
       a.kind,
       CASE WHEN a.state = 'deleted' THEN NULL ELSE a.handle END AS handle,
       CASE WHEN a.state = 'deleted' THEN NULL ELSE a.display_name END AS "displayName",
       a.state AS "nativeState",
       a.authn_fenced AS "authnFenced",
       CASE WHEN a.state = 'deleted' THEN NULL ELSE a.operator_account_id::text END AS "operatorId",
       CASE WHEN a.state = 'active' AND NOT a.authn_fenced THEN a.avatar::text END AS "avatarMediaId"
FROM unnest(:account_ids::uuid[]) WITH ORDINALITY
  AS requested(account_id, ordinal)
JOIN LATERAL (
  SELECT account_id, kind, state, authn_fenced, handle, display_name, operator_account_id, avatar
  FROM access.account
  WHERE route = :route::integer AND account_id = requested.account_id AND state <> 'pending'
  LIMIT 1
) a ON true
ORDER BY requested.ordinal;
