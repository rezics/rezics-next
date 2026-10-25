SELECT reservation_id AS "reservationId", related_account_id AS "subjectAccountId"
FROM access.lifecycle_coordination
WHERE route = :route AND account_id = :operator_id
  AND reservation_id = :reservation_id AND purpose = 'operator';
