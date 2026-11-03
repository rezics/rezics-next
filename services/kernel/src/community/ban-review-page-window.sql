-- Seek only open keys in the native partial btree. Materialization prevents the
-- payload join or temporal primary key from becoming a history scan. The tuple
-- lower bound is intentional: the bounded neighbour is discarded below.
WITH keys AS MATERIALIZED (
  SELECT realm_id, account_id, valid
  FROM community.realm_ban
  WHERE route = :route::integer AND upper_inf(valid)
    AND (realm_id, account_id) > (:realm_id::uuid, :after::uuid)
  ORDER BY realm_id, account_id
  LIMIT :limit::integer
)
SELECT k.account_id::text AS "accountId", b.reason, b.actor::text AS actor,
       lower(k.valid)::text AS at, b.transaction_id::text AS episode
FROM keys k
JOIN LATERAL (
  SELECT reason, actor, transaction_id FROM community.realm_ban b
  WHERE b.route = :route::integer AND b.realm_id = k.realm_id
    AND b.account_id = k.account_id AND b.valid = k.valid
  LIMIT 1
) b ON true
WHERE k.realm_id = :realm_id::uuid
ORDER BY k.account_id;
