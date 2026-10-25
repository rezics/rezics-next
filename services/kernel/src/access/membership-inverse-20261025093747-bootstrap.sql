-- One actual source change, found with the authoritative membership anchor key.
-- Preserve a pre-upgrade live reservation so later leave/release uses its slot.
-- This backfill step never certifies that all source cursors have been drained.
SELECT m.transaction_id AS "transactionId", s.reservation_id AS "reservationId"
FROM access.organization_member m
LEFT JOIN access.lifecycle_membership_slot s ON s.route = m.route
  AND s.organization_id = m.organization_id AND s.member_account_id = m.member_account_id AND NOT s.terminal
WHERE m.route = :route AND m.organization_id = :group_id AND m.member_account_id = :account_id
  AND m.transaction_id = :source_transaction_id
LIMIT 1;
