-- One organization and one explicitly selected member, never a holder feed.
-- The slot must be installed by the same transaction as the current native role.
SELECT a.kind, a.state, a.authn_fenced AS fenced,
       m.role, m.row_key::text AS "membershipKey",
       s.reservation_id::text AS "reservationId"
FROM access.account a
LEFT JOIN LATERAL (
  SELECT role, row_key, transaction_id FROM access.organization_member m
  WHERE m.route = a.route AND m.organization_id = a.account_id
    AND m.member_account_id = :member_id::uuid AND m.valid @> :at::timestamptz
  LIMIT 1
) m ON true
LEFT JOIN access.lifecycle_membership_slot s ON s.route = a.route AND s.organization_id = a.account_id
  AND s.member_account_id = :member_id::uuid AND s.reservation_id = :reservation_id::nullable(uuid)
  AND s.transaction_id = m.transaction_id AND NOT s.terminal
WHERE a.route = :route AND a.account_id = :organization_id
LIMIT 2;
