SELECT retention_store AS store, retention_fields AS fields, retention_purpose AS purpose,
       to_char(retention_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt"
FROM commerce.erasure_progress
WHERE route = :route AND account_id = :account_id
FOR UPDATE;
