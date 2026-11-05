SELECT group_id::text AS id
FROM access.membership_inverse
WHERE route = :route::integer
  AND account_id = :account_id::uuid
  AND kind = 'realm'
  AND group_id > :after::uuid
ORDER BY group_id
LIMIT :limit::integer;
