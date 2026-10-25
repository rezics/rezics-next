SELECT to_jsonb(r) AS data FROM access.workflow_approval r
WHERE route = :route AND approval_id = :receipt_id AND consumed_at IS NOT NULL
  AND operation->>'kind' = 'credential' AND expires_at > clock_timestamp() AND jwt_expires_at > clock_timestamp();
