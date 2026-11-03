-- One current full key, even with arbitrarily many historical intervals.
WITH input AS (SELECT :route::integer AS route, :realm_id::uuid AS realm_id, :account_id::uuid AS account_id),
candidate AS MATERIALIZED (
  SELECT b.route, b.realm_id, b.account_id, b.valid FROM input, community.realm_ban b
  WHERE b.route = input.route AND upper_inf(valid)
    AND (b.realm_id, b.account_id) >= (input.realm_id, input.account_id)
  ORDER BY b.realm_id, b.account_id LIMIT 1
)
SELECT c.account_id::text AS "accountId", b.reason, b.actor::text AS actor,
       lower(c.valid)::text AS at, b.transaction_id::text AS episode
FROM input, candidate c
JOIN LATERAL (
  SELECT reason, actor, transaction_id FROM community.realm_ban b
  WHERE b.route = c.route AND b.realm_id = c.realm_id
    AND b.account_id = c.account_id AND b.valid = c.valid
  LIMIT 1
) b ON true
WHERE c.realm_id = input.realm_id AND c.account_id = input.account_id;
