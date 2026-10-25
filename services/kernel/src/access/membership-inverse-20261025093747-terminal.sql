SELECT transaction_id AS "transactionId"
FROM access.lifecycle_membership_slot
WHERE route = :route AND organization_id = :group_id AND member_account_id = :account_id
  AND reservation_id = :reservation_id AND terminal;
