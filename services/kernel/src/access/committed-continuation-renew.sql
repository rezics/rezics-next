WITH input AS (SELECT :expires_at::timestamptz AS expires_at)
UPDATE access.committed_continuation AS continuation
SET expires_at = input.expires_at
FROM input
WHERE continuation.route = :route
  AND continuation.continuation_id = :continuation_id
  AND continuation.expires_at < input.expires_at
RETURNING continuation.expires_at AS "expiresAt";
