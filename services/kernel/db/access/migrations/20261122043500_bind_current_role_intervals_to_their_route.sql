-- migrate:up
-- Validate each retained boundary and membership against the interval on its resource route.
DO $routed_intervals$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='access.resource_role_grant'::regclass
      AND conname='resource_role_grant_route_interval'
  ) THEN
    ALTER TABLE access.resource_role_grant ADD CONSTRAINT resource_role_grant_route_interval UNIQUE (route,erasure_key);
  END IF;
END
$routed_intervals$;
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
ALTER TABLE access.resource_role_grant DROP CONSTRAINT IF EXISTS resource_role_grant_route_interval;
