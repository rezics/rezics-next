-- migrate:up
CREATE INDEX work_legacy_leave_parent_input_identity
  ON dbos.workflow_input (
    (inputs::jsonb #>> '{json,0,realmId}'),
    (inputs::jsonb #>> '{json,0,memberAccountId}'),
    (inputs::jsonb #>> '{json,0,reservationId}')
  ) INCLUDE (workflow_uuid);

CREATE INDEX work_legacy_leave_child_input_identity
  ON dbos.workflow_input (
    (inputs::jsonb #>> '{json,0,principal,id}'),
    (inputs::jsonb #>> '{json,0,memberAccountId}'),
    (inputs::jsonb #>> '{json,0,reservationId}')
  ) INCLUDE (workflow_uuid);

-- migrate:down
DROP INDEX dbos.work_legacy_leave_child_input_identity;
DROP INDEX dbos.work_legacy_leave_parent_input_identity;
