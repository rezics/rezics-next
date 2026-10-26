WITH input AS NOT MATERIALIZED (SELECT :route::integer AS route), candidates AS MATERIALIZED (
  SELECT a.route, a.approval_id FROM access.workflow_approval a CROSS JOIN input i
  WHERE a.route = i.route AND a.expires_at <= :at::timestamptz
  ORDER BY a.expires_at, a.approval_id LIMIT :limit
), expired AS MATERIALIZED (
  SELECT a.route, a.approval_id
  FROM candidates c CROSS JOIN input i CROSS JOIN LATERAL (
    SELECT a.route, a.approval_id FROM access.workflow_approval a
    WHERE a.route = i.route AND a.approval_id = c.approval_id
    FOR UPDATE SKIP LOCKED
  ) a
)
DELETE FROM access.workflow_approval a USING expired e, input i
WHERE a.route = i.route AND a.approval_id = e.approval_id
RETURNING a.approval_id;
