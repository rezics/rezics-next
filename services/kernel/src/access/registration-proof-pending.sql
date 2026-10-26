SELECT account_id AS "accountId", registration_id AS "registrationId",
       registration_expires_at::text AS "expiresAt", operator_account_id AS "operatorAccountId"
FROM access.account
WHERE route = :route AND account_id = :account_id
  AND kind = 'actor' AND state = 'pending' AND NOT authn_fenced
  AND minimum_authn_epoch = 1
  AND handle = :handle AND registration_id = :reservation_id
  AND registration_expires_at = :expires_at::timestamptz
  AND registration_expires_at > :at::timestamptz
  AND transaction_id = :transaction_id
  AND operator_account_id IS NOT DISTINCT FROM NULLIF(:operator_id::text, '')::uuid
  AND operator_reservation_id IS NOT DISTINCT FROM NULLIF(:operator_reservation_id::text, '')::uuid
  AND operator_relation_version = :operator_version::bigint;
