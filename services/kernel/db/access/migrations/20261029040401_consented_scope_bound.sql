-- migrate:up
-- Workflow approvals retain the same bounded actor snapshots as durable operations.
ALTER TABLE access.workflow_approval
  DROP CONSTRAINT workflow_approval_scopes_check,
  ADD CONSTRAINT workflow_approval_scopes_check CHECK (
    cardinality(scopes) <= 512 AND octet_length(array_to_string(scopes, ' ')) <= 66047),
  DROP CONSTRAINT workflow_approval_operation_check,
  ADD CONSTRAINT workflow_approval_operation_check CHECK (
    jsonb_typeof(operation) = 'object' AND octet_length(operation::text) <=
      CASE WHEN operation->>'kind' = 'client-reduction' THEN 69119 ELSE 16384 END);

-- migrate:down
-- Forward only: retained approvals may exceed the previous scope bounds.
