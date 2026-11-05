-- Seek only open keys in the native partial btree. Materialization prevents the
-- payload join or temporal primary key from becoming a history scan. The tuple
-- lower bound is intentional: the bounded neighbour is discarded below.
WITH input AS (SELECT :route::integer AS route, :realm_id::uuid AS realm_id),
keys AS MATERIALIZED (
  SELECT b.route, b.realm_id, b.account_id, b.valid
  FROM input, community.realm_ban b
  WHERE b.route = input.route AND upper_inf(valid)
    AND (b.realm_id, account_id) > (input.realm_id, :after::uuid)
  ORDER BY b.realm_id, account_id
  LIMIT :limit::integer
)
SELECT k.account_id::text AS "accountId", b.reason, b.actor::text AS actor,
       lower(k.valid)::text AS at, b.transaction_id::text AS episode
FROM input, keys k
JOIN LATERAL (
  SELECT reason, actor, transaction_id FROM community.realm_ban b
  WHERE b.route = k.route AND b.realm_id = k.realm_id
    AND b.account_id = k.account_id AND b.valid = k.valid
  LIMIT 1
) b ON true
WHERE k.realm_id = input.realm_id
ORDER BY k.account_id;
