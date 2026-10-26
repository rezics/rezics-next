SELECT operator_account_id AS "operatorAccountId", terminal
FROM access.operator_relation_slot
WHERE route = :route::integer AND subject_account_id = :account_id::uuid
  AND reservation_id = NULLIF(:reservation_id::text, '')::uuid
  AND operator_account_id = NULLIF(:operator_id::text, '')::uuid
FOR UPDATE;
