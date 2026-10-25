-- migrate:up
CREATE UNIQUE INDEX resource_denial_open ON access.resource_denial
  (route, resource_id, subject_id, subject_role, action, reason) WHERE upper_inf(valid);

CREATE UNIQUE INDEX resource_role_grant_open ON access.resource_role_grant
  (route, resource_id, subject_kind, subject_id, subject_role, grant_role) WHERE upper_inf(valid);

-- migrate:down
DROP INDEX access.resource_role_grant_open;
DROP INDEX access.resource_denial_open;
