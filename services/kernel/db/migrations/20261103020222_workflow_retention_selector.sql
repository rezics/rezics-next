-- migrate:up
CREATE INDEX workflow_retention_selector
  ON dbos.workflow_status (application_name, completed_at, workflow_uuid)
  WHERE status IN ('SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED');

-- migrate:down
DROP INDEX dbos.workflow_retention_selector;
