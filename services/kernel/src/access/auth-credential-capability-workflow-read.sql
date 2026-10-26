WITH authority AS (SELECT :at::timestamptz AS at)
SELECT to_jsonb(r) AS data,
       route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
       scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
       operation_key AS "operationKey", operation, digest,
       created_at::text AS "createdAt", expires_at::text AS "expiresAt",
       jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
FROM access.workflow_approval r CROSS JOIN authority t
WHERE route = :route AND approval_id = :receipt_id AND consumed_at IS NOT NULL
  AND operation->>'kind' = 'credential' AND expires_at > t.at AND jwt_expires_at > t.at;
