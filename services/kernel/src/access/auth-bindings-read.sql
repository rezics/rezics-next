SELECT registration_id AS "registrationId", registration_expires_at::text AS "expiresAt"
FROM access.account
WHERE route = :route AND account_id = :account_id;
