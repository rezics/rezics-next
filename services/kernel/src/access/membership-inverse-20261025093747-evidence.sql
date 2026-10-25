-- Both relations are on the member anchor. This is reservation evidence only,
-- never proof of authoritative organization membership.
-- Matching identity without matching immutable operation provenance is unsafe.
SELECT i.reservation_id AS "reservationId"
FROM access.membership_inverse i
JOIN access.lifecycle_coordination c ON c.route = i.route AND c.account_id = i.account_id
  AND c.reservation_id = i.reservation_id AND c.related_account_id = i.group_id AND c.purpose = 'membership'
  AND c.transaction_id = i.transaction_id
JOIN access.account a ON a.route = i.route AND a.account_id = i.account_id AND a.membership_inverse_complete
WHERE i.route = :route AND i.account_id = :account_id AND i.kind = 'organization'
  AND i.group_id = :group_id AND i.reservation_id = :reservation_id;
