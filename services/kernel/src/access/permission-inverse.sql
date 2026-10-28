-- Coverage is the canonical account flag, projected without rereading actor
-- state. This view and the real inverse remain on the admitted actor's anchor.
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
  SELECT i.kind, i.group_id FROM access.membership_inverse i
  WHERE i.route = c.route AND i.account_id = c.account_id OFFSET 0
) i ON true;
