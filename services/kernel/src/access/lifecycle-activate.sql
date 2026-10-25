UPDATE access.account
SET state = 'active', registration_id = NULL, registration_expires_at = NULL, transaction_id = :transaction_id
WHERE route = :route AND account_id = :account_id AND state = 'pending' AND NOT authn_fenced
  AND registration_id = :registration_id AND registration_expires_at > :at::timestamptz
  AND minimum_authn_epoch <= :authn_epoch
RETURNING account_id;
