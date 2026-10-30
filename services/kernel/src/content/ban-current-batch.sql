SELECT account_id::text AS account_id
FROM community.realm_ban
WHERE route = :route::integer AND realm_id = :realm_id::uuid
  AND account_id = ANY(:account_ids::uuid[]) AND upper_inf(valid)
  AND valid @> :at::timestamptz;
