-- Coverage is the canonical account flag, projected without rereading actor
-- state. Each admitted membership kind has its own complete account-keyed
-- range; unrelated accounts never become a hash-join input. Do not truncate.
WITH parameters AS MATERIALIZED (
  SELECT :members::nullable(jsonb) AS members, :route::integer AS route, :account_id::uuid AS account_id
), members AS MATERIALIZED (
  SELECT r.route, r.account_id
  FROM parameters p CROSS JOIN jsonb_to_recordset(p.members) AS r(route integer, account_id uuid)
  UNION ALL
  SELECT p.route, p.account_id FROM parameters p WHERE p.members IS NULL
)
SELECT c.account_id::text AS "accountId", c.complete, i.kind, i.group_id::text AS id
FROM members m
JOIN LATERAL (
  SELECT c.account_id, c.route, c.complete FROM access.membership_inverse_coverage c
  WHERE c.route = m.route AND c.account_id = m.account_id LIMIT 1
) c ON true
LEFT JOIN LATERAL (
  SELECT membership.kind, membership.group_id
  FROM (VALUES ('organization'), ('realm')) AS k(kind)
  CROSS JOIN LATERAL (
    SELECT kind, group_id FROM access.membership_inverse
    WHERE route = c.route AND account_id = c.account_id AND kind = k.kind
    ORDER BY group_id
    OFFSET 0
  ) membership
) i ON true;
