SELECT terminal
FROM access.lifecycle_membership_slot
WHERE route = :route AND organization_id = :organization_id
  AND member_account_id = :member_id AND reservation_id = :reservation_id;
