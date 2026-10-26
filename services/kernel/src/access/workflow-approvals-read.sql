WITH input AS (SELECT :at::timestamptz AS at)
SELECT route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
       scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
       operation_key AS "operationKey", operation, digest,
       created_at::text AS "createdAt", expires_at::text AS "expiresAt",
       jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId"
FROM access.workflow_approval CROSS JOIN input i
WHERE route = :route AND approval_id = :approval_id
  AND expires_at > i.at AND jwt_expires_at > i.at;
