/* work:workflow-retention-select */
SELECT workflow_uuid
FROM dbos.workflow_status
WHERE application_name = :application_name::text
  AND completed_at < :completed_before::bigint
  AND status IN ('SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
ORDER BY completed_at, workflow_uuid
LIMIT :limit::integer;
