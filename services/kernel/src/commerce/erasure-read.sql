SELECT had_data AS "hadData", cursor_id AS cursor, phase, blocker, retention_store AS "retentionStore",
  retention_fields AS "retentionFields", retention_purpose AS "retentionPurpose",
  retention_expires_at::text AS "retentionExpiresAt"
FROM commerce.erasure_progress
WHERE route = :route::integer AND account_id = :account_id::uuid
FOR UPDATE;
