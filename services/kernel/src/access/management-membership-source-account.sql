-- Exact selected member anchor; incomplete inverse evidence is not nonmembership.
SELECT a.kind, a.state, a.authn_fenced AS fenced,
       a.membership_inverse_complete AS complete,
       i.reservation_id::text AS "reservationId", c.transaction_id::text AS "reservationTransactionId"
FROM access.account a
LEFT JOIN access.membership_inverse i ON i.route = a.route AND i.account_id = a.account_id
  AND i.kind = 'organization' AND i.group_id = :organization_id::uuid
LEFT JOIN access.lifecycle_coordination c ON c.route = i.route AND c.account_id = i.account_id
  AND c.reservation_id = i.reservation_id AND c.related_account_id = i.group_id
  AND c.purpose = 'membership' AND c.transaction_id = i.transaction_id
WHERE a.route = :route AND a.account_id = :member_id;
