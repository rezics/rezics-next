SELECT route,
       account_id::text AS "accountId",
       kind,
       handle,
       display_name AS "displayName",
       operator_account_id::text AS "operatorAccountId",
       authn_fenced AS fenced,
       state
FROM access.account
WHERE state = 'active'
  AND NOT authn_fenced
  AND (route, account_id) > (:after_route::integer, :after_account_id::uuid)
ORDER BY route, account_id
LIMIT :page_size::integer;
