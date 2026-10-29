SELECT 1 AS pending FROM dbos.workflow_status
WHERE queue_name = :queue::text AND status IN ('ENQUEUED', 'PENDING')
  AND created_at <= :workflow_until::bigint
ORDER BY queue_name, status, priority, created_at
LIMIT 1;
