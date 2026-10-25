SELECT account_id AS "accountId", kind, state, handle,
       operator_account_id AS "operatorAccountId", authn_fenced AS fenced,
       registration_id AS "registrationId", registration_expires_at::text AS "expiresAt",
       minimum_authn_epoch::text AS "minimumAuthnEpoch", fence_receipt_id AS "receiptId"
FROM access.account
WHERE route = :route AND account_id = :account_id
FOR UPDATE;
