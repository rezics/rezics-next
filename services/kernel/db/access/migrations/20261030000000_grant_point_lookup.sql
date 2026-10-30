-- migrate:up
-- Non-overlap makes the last range starting by T the only possible live grant.
CREATE INDEX resource_grant_point_lookup ON access.resource_grant
  (route, resource_id, subject_kind, subject_id, subject_role, action, valid);

-- migrate:down
DROP INDEX access.resource_grant_point_lookup;
