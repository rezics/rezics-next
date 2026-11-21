-- migrate:up
-- Validate each retained boundary and membership against the interval on its resource route.
ALTER TABLE access.resource_role_grant ADD CONSTRAINT resource_role_grant_route_interval UNIQUE (route,erasure_key);
ALTER TABLE access.current_resource_role_key
  DROP CONSTRAINT current_resource_role_key_interval_key_fkey,
  ADD CONSTRAINT current_resource_role_key_interval_key_fkey FOREIGN KEY(route,interval_key)
    REFERENCES access.resource_role_grant(route,erasure_key) ON DELETE CASCADE;
ALTER TABLE access.current_resource_role_due
  DROP CONSTRAINT current_resource_role_due_interval_key_fkey,
  ADD CONSTRAINT current_resource_role_due_interval_key_fkey FOREIGN KEY(route,interval_key)
    REFERENCES access.resource_role_grant(route,erasure_key) ON DELETE CASCADE;

-- migrate:down
ALTER TABLE access.current_resource_role_key
  DROP CONSTRAINT current_resource_role_key_interval_key_fkey,
  ADD CONSTRAINT current_resource_role_key_interval_key_fkey FOREIGN KEY(interval_key)
    REFERENCES access.resource_role_grant(erasure_key) ON DELETE CASCADE;
ALTER TABLE access.current_resource_role_due
  DROP CONSTRAINT current_resource_role_due_interval_key_fkey,
  ADD CONSTRAINT current_resource_role_due_interval_key_fkey FOREIGN KEY(interval_key)
    REFERENCES access.resource_role_grant(erasure_key) ON DELETE CASCADE;
ALTER TABLE access.resource_role_grant DROP CONSTRAINT resource_role_grant_route_interval;
