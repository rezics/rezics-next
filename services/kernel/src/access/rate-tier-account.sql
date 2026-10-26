SELECT kind, operator_account_id AS "operatorAccountId", operator_reservation_id AS "operatorReservationId"
FROM access.account
WHERE route = :route::integer AND account_id = :account_id::uuid AND state = 'active'
FOR UPDATE;
