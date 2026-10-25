-- migrate:up
-- Schema maintenance builds this index once; online guards visit at most two
-- current owners without walking unrelated members or expired owner history.
CREATE INDEX organization_member_owner_probe
  ON access.organization_member USING gist (route, organization_id, valid)
  WHERE role = 'owner';

-- migrate:down
-- Forward only: owner guards depend on this selective temporal probe.
