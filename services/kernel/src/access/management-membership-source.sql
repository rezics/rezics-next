-- One organization and one explicitly selected member, never a holder feed.
-- The slot must be installed by the same transaction as the current native role.
WITH input AS (
  SELECT :member_id::uuid AS member_id, :at::timestamptz AS at,
         :reservation_id::nullable(uuid) AS reservation_id,
         :route::integer AS route, :organization_id::uuid AS organization_id
)
SELECT a.kind, a.state, a.authn_fenced AS fenced,
       m.role, m.row_key::text AS "membershipKey",
       s.reservation_id::text AS "reservationId"
FROM input i
JOIN access.account a ON a.route = i.route AND a.account_id = i.organization_id
LEFT JOIN LATERAL (
  SELECT role, row_key, transaction_id FROM access.organization_member m
  WHERE m.route = a.route AND m.organization_id = a.account_id
    AND m.member_account_id = i.member_id AND m.valid @> i.at
  LIMIT 1
) m ON true
LEFT JOIN access.lifecycle_membership_slot s ON s.route = a.route AND s.organization_id = a.account_id
  AND s.member_account_id = i.member_id AND s.reservation_id = i.reservation_id
  AND s.transaction_id = m.transaction_id AND NOT s.terminal
LIMIT 2;
