DELETE FROM access.lifecycle_coordination
WHERE route = :route AND account_id = :account_id
  AND related_account_id = :organization_id AND reservation_id = :reservation_id
  AND purpose = 'membership'
RETURNING reservation_id AS "reservationId";
