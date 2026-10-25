SELECT reservation_id AS "reservationId", related_account_id AS "relatedAccountId", purpose
FROM access.lifecycle_coordination
WHERE route = :route AND account_id = :account_id AND reservation_id = :reservation_id;
