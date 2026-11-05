SELECT version, at::text, completed_at::text AS "completedAt", frontier, workflow_until::text AS "workflowUntil"
FROM access.erasure
WHERE route = :route::integer AND account_id = :account_id::uuid
FOR UPDATE;
