SELECT transaction_id::text AS "transactionId", issued_valid::text AS "issuedValid"
FROM access.principal_assignment
WHERE route = :route AND principal_id = :principal_id AND request_id = :request_id
  AND creator_principal_id = principal_id AND assigned_actor_id = :actor_id
  AND revoked_at IS NULL AND valid @> :at::timestamptz;
