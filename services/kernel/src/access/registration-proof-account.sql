SELECT account_id AS "accountId"
FROM access.account
WHERE route = :route AND account_id = :account_id
  AND kind = 'actor' AND state = 'pending' AND NOT authn_fenced
  AND operator_account_id IS NULL
  AND minimum_authn_epoch BETWEEN 1 AND 9007199254740991
  AND handle = :handle AND registration_id = :reservation_id
  AND registration_expires_at = :expires_at::timestamptz
  AND registration_expires_at > :at::timestamptz
  AND transaction_id = :transaction_id;
