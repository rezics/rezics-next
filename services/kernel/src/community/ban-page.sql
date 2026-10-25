SELECT account_id::text AS "accountId", reason, actor::text AS actor, lower(valid)::text AS at
FROM community.realm_ban
WHERE route = :route::integer AND realm_id = :realm_id::uuid
  AND upper_inf(valid) AND account_id > :after::uuid
ORDER BY account_id
LIMIT :limit::integer;
