SELECT retention_store AS store, retention_fields AS fields, retention_purpose AS purpose,
       retention_expires_at::text AS "expiresAt"
FROM commerce.erasure_progress
WHERE route = :route AND account_id = :account_id
FOR UPDATE;
