DELETE FROM community.member_locator_pending
WHERE account_id = :account_id::uuid AND route = :route::integer
  AND realm_id = :realm_id::uuid AND transaction_id = :transaction_id::uuid
RETURNING transaction_id::text;
