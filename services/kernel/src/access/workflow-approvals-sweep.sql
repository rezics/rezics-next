WITH candidates AS MATERIALIZED (
  SELECT route, approval_id FROM access.workflow_approval
  WHERE route = :route AND expires_at <= :at::timestamptz
  ORDER BY expires_at, approval_id LIMIT :limit
), expired AS MATERIALIZED (
  SELECT a.route, a.approval_id
  FROM candidates c CROSS JOIN LATERAL (
    SELECT route, approval_id FROM access.workflow_approval a
    WHERE a.route = c.route AND a.approval_id = c.approval_id
    FOR UPDATE SKIP LOCKED
  ) a
)
DELETE FROM access.workflow_approval a USING expired e
WHERE a.route = e.route AND a.approval_id = e.approval_id
RETURNING a.approval_id;
