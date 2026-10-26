UPDATE access.account
SET rate_tier = :tier::text, transaction_id = :transaction_id::uuid
WHERE route = :route::integer AND account_id = :account_id::uuid AND state = 'active' AND kind = :kind::text
  AND operator_account_id IS NOT DISTINCT FROM NULLIF(:operator_id::text, '')::uuid
  AND operator_reservation_id IS NOT DISTINCT FROM NULLIF(:reservation_id::text, '')::uuid
RETURNING account_id AS "accountId";
