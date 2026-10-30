-- migrate:up
-- Keep one native temporal candidate per exact resource/subject/role key.
CREATE INDEX resource_role_grant_point_lookup ON access.resource_role_grant
  (route, resource_id, subject_kind, subject_id, subject_role, grant_role, valid);

-- migrate:down
DROP INDEX access.resource_role_grant_point_lookup;
