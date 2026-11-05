-- migrate:up
CREATE INDEX auth_workflow_request_automated_registration
  ON auth_workflow_request ((request->>'registrationId'))
  WHERE request->>'kind'='automated';

-- migrate:down
DROP INDEX auth_workflow_request_automated_registration;
