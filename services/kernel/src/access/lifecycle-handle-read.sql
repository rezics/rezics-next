SELECT account_id AS "accountId", normalized_handle AS handle, state,
       reservation_id AS "reservationId", expires_at::text AS "expiresAt", reserved_until::text AS "reservedUntil",
       former_until::text AS "formerUntil",
       hold_operation_id AS "operationId", hold_expected_handle AS "expectedHandle"
FROM access.handle_claim
WHERE route = :route AND normalized_handle = :handle;
