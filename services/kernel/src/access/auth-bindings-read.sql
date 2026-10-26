SELECT registration_id AS "registrationId", registration_expires_at::text AS "expiresAt"
FROM access.account
WHERE route = :route AND account_id = :account_id
  AND kind = 'actor' AND state = 'pending' AND NOT authn_fenced
  AND registration_expires_at = :expires_at::timestamptz
  AND registration_expires_at > :at::timestamptz;
