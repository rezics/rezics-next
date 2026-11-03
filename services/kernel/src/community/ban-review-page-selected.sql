-- One current full key, even with arbitrarily many historical intervals.
WITH candidate AS MATERIALIZED (
  SELECT realm_id, account_id, valid FROM community.realm_ban
  WHERE route = :route::integer AND upper_inf(valid)
    AND (realm_id, account_id) >= (:realm_id::uuid, :account_id::uuid)
  ORDER BY realm_id, account_id LIMIT 1
)
SELECT c.account_id::text AS "accountId", b.reason, b.actor::text AS actor,
       lower(c.valid)::text AS at, b.transaction_id::text AS episode
FROM candidate c
JOIN LATERAL (
  SELECT reason, actor, transaction_id FROM community.realm_ban b
  WHERE b.route = :route::integer AND b.realm_id = c.realm_id
    AND b.account_id = c.account_id AND b.valid = c.valid
  LIMIT 1
) b ON true
WHERE c.realm_id = :realm_id::uuid AND c.account_id = :account_id::uuid;
