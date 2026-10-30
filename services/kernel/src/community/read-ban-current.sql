-- At most two current keys: the actor and an authenticated delegating principal.
-- The Realm's partial current-ban index excludes closed history from both seeks.
SELECT true AS banned
FROM community.realm_ban
WHERE route = :route::integer AND realm_id = :realm_id::uuid
  AND account_id = ANY(:account_ids::uuid[]) AND upper_inf(valid)
  AND valid @> :at::timestamptz
LIMIT 1;
