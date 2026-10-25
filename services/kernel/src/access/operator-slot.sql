SELECT operator_account_id AS "operatorAccountId", terminal
FROM access.operator_relation_slot
WHERE route = :route AND subject_account_id = :subject_id AND reservation_id = :reservation_id;
