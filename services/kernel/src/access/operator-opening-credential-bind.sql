WITH input AS (SELECT :expires_at::timestamptz AS expires_at, :at::timestamptz AS at)
UPDATE access.operator_opening_receipt r
SET credential_purpose = :credential_purpose, credential_operation_key = :operation_key,
    credential_effect_reference = :effect_reference, credential_effect_digest = :effect_digest,
    expires_at = LEAST(r.expires_at, i.expires_at)
FROM input i
WHERE route = :route AND operator_account_id = :operator_id AND receipt_id = :receipt_id
  AND purpose = 'credential-management' AND consumed_at IS NULL AND credential_purpose IS NULL
  AND i.at < LEAST(r.expires_at, i.expires_at)
RETURNING r.expires_at::text AS "expiresAt";
