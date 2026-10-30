SELECT a.kind, a.state, a.authn_fenced AS fenced,
       a.operator_account_id AS "operatorAccountId",
       a.operator_reservation_id AS "reservationId",
       a.operator_relation_version::text AS version,
       s.operator_account_id AS "slotOperatorAccountId", s.terminal
FROM access.account a
LEFT JOIN access.operator_relation_slot s
  ON s.route = a.route AND s.subject_account_id = a.account_id
  AND s.reservation_id = a.operator_reservation_id
WHERE a.route = :route AND a.account_id = :subject_id;
