SELECT operator_account_id AS "operatorAccountId", operator_reservation_id AS "reservationId",
       operator_relation_version::text AS version
FROM access.account
WHERE route = :route AND account_id = :account_id;
