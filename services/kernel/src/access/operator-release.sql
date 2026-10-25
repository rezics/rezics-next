DELETE FROM access.lifecycle_coordination AS c
USING access.account AS a
WHERE c.route = :route AND c.account_id = :operator_id AND c.reservation_id = :reservation_id
  AND c.related_account_id = :subject_id AND c.purpose = 'operator'
  AND a.route = c.route AND a.account_id = c.account_id AND a.state = 'active'
RETURNING c.reservation_id AS "reservationId";
