-- migrate:up
ALTER TABLE semantic.context
  ADD COLUMN state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleted', 'purged')),
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN purge_after timestamptz,
  ADD COLUMN security_revision bigint NOT NULL DEFAULT 0 CHECK (security_revision >= 0),
  ADD COLUMN held boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT context_lifecycle_window CHECK (
    (deleted_at IS NULL AND purge_after IS NULL AND state = 'active') OR
    (deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after = deleted_at + interval '720 hours')
  ),
  ADD CONSTRAINT context_global_active CHECK (kind <> 'global' OR state = 'active');
-- Current availability is a point probe, including when most Contexts are deleted.
CREATE INDEX context_active ON semantic.context (route, context_id) WHERE state = 'active';

-- migrate:down
DROP INDEX semantic.context_active;
ALTER TABLE semantic.context
  DROP CONSTRAINT context_global_active,
  DROP CONSTRAINT context_lifecycle_window,
  DROP COLUMN held,
  DROP COLUMN security_revision,
  DROP COLUMN purge_after,
  DROP COLUMN deleted_at,
  DROP COLUMN state;
