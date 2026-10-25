DELETE FROM access.lifecycle_coordination
WHERE route = :route AND account_id = :operator_id AND reservation_id = :reservation_id
  AND related_account_id = :subject_id AND purpose = 'operator'
RETURNING reservation_id AS "reservationId";
