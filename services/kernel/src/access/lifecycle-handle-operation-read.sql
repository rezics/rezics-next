SELECT handle, reservation_id AS "reservationId", expected_handle AS "expectedHandle",
       old_reservation_id AS "oldReservationId", state
FROM access.lifecycle_handle_operation
WHERE route = :route AND account_id = :account_id AND operation_id = :operation_id;
