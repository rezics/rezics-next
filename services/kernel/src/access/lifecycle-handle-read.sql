SELECT account_id AS "accountId", normalized_handle AS handle, state,
       reservation_id AS "reservationId", expires_at::text AS "expiresAt", reserved_until::text AS "reservedUntil"
FROM access.handle_claim
WHERE route = :route AND normalized_handle = :handle;
