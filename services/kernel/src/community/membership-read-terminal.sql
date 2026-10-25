SELECT transaction_id::text AS "transactionId"
FROM community.realm_member_terminal
WHERE route = :route::integer AND realm_id = :realm_id::uuid
  AND account_id = :account_id::uuid AND reservation_id = :reservation_id::uuid;
