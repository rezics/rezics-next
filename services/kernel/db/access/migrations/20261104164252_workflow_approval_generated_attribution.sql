-- migrate:up
-- Stored generated attribution is available only after BEFORE triggers run.
-- Validate the complete row after generation; any refusal rolls back the update.
DROP TRIGGER workflow_approval_immutable ON access.workflow_approval;
CREATE TRIGGER workflow_approval_immutable AFTER UPDATE ON access.workflow_approval
FOR EACH ROW EXECUTE FUNCTION access.workflow_approval_immutable();

-- migrate:down
DROP TRIGGER workflow_approval_immutable ON access.workflow_approval;
CREATE TRIGGER workflow_approval_immutable BEFORE UPDATE ON access.workflow_approval
FOR EACH ROW EXECUTE FUNCTION access.workflow_approval_immutable();
