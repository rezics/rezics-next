SELECT route, account_id::text AS "accountId", handle, kind,
       public_changed_at::text AS "lastModified"
FROM access.account
WHERE state = 'active' AND NOT authn_fenced AND handle IS NOT NULL
  AND (route, account_id) > (:after_route::integer, :after_account_id::uuid)
ORDER BY route, account_id
LIMIT :limit::integer;
