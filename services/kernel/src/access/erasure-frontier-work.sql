SELECT EXISTS (
  SELECT 1 FROM dbos.workflow_status w
  WHERE w.queue_name = :queue::text AND w.status IN ('ENQUEUED', 'PENDING')
    AND w.created_at <= e.workflow_until
) AS pending
FROM access.erasure e
WHERE route = :route::integer AND account_id = :account_id::uuid AND workflow_until IS NOT NULL;
