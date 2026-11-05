SELECT membership_inverse_complete AS "membershipInverseComplete", account_id AS "accountId", kind, state, handle,
       display_name AS "displayName",
       operator_account_id AS "operatorAccountId", operator_reservation_id AS "operatorReservationId",
       authn_fenced AS fenced,
       registration_id AS "registrationId", registration_expires_at::text AS "expiresAt",
       minimum_authn_epoch::text AS "minimumAuthnEpoch", fence_receipt_id AS "receiptId", handle_operation_id AS "handleOperationId"
FROM access.account
WHERE route = :route AND account_id = :account_id
FOR UPDATE;
