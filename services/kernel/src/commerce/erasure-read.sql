SELECT had_data AS "hadData", cursor_id AS cursor, phase, blocker, retention_store AS "retentionStore",
  retention_fields AS "retentionFields", retention_purpose AS "retentionPurpose",
  to_char(retention_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "retentionExpiresAt"
FROM commerce.erasure_progress
WHERE route = :route::integer AND account_id = :account_id::uuid
FOR UPDATE;
