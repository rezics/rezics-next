WITH input AS NOT MATERIALIZED (
  SELECT :at::timestamptz AS at, :jwt_expires_at::timestamptz AS jwt_expires_at
)
INSERT INTO access.workflow_approval
  (route, approval_id, actor_id, client_id, scopes, requested_by, authn_epoch,
   operation_key, operation, digest, created_at, expires_at, jwt_expires_at, transaction_id)
SELECT :route, :approval_id, :actor_id, :client_id, :scopes::text[],
       :requested_by::nullable(text), :authn_epoch::bigint, :operation_key,
       :operation::jsonb, :digest, i.at,
       LEAST(i.jwt_expires_at, i.at + interval '300 seconds'),
       i.jwt_expires_at, :transaction_id
FROM input i
WHERE i.jwt_expires_at > i.at AND i.jwt_expires_at > clock_timestamp()
RETURNING route, approval_id AS "approvalId", actor_id AS "actorId", client_id AS "clientId",
       scopes, requested_by AS "requestedBy", authn_epoch::text AS "authnEpoch",
       operation_key AS "operationKey", operation, digest,
       created_at::text AS "createdAt", expires_at::text AS "expiresAt",
       jwt_expires_at::text AS "jwtExpiresAt", transaction_id AS "transactionId";
