-- Preflight only: finish this exact actor read before reading group evidence.
-- The command later compares reservation_id again under the account lock.
SELECT reservation_id AS "reservationId"
FROM access.membership_inverse
WHERE route = :route AND account_id = :account_id AND kind = :kind AND group_id = :group_id;
