UPDATE access.account
SET minimum_authn_epoch = minimum_authn_epoch + 1, transaction_id = :transaction_id::uuid
WHERE route = :route AND account_id = :account_id AND kind = 'actor' AND state = 'active'
  AND operator_account_id IS NULL AND NOT authn_fenced AND minimum_authn_epoch = :previous_floor::bigint
RETURNING minimum_authn_epoch::text AS "minimumAuthnEpoch";
