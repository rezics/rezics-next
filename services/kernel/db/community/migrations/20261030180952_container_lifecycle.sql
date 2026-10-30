-- migrate:up
ALTER TABLE community.space
  DROP CONSTRAINT space_state_check,
  ADD CONSTRAINT space_state_check CHECK (state IN ('active', 'removed')),
  ADD COLUMN lifecycle_version bigint NOT NULL DEFAULT 0 CHECK (lifecycle_version >= 0),
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_by uuid,
  ADD COLUMN remover_role text CHECK (remover_role IN ('owner', 'moderator')),
  ADD COLUMN removal_reason text CHECK (char_length(removal_reason) BETWEEN 1 AND 1024),
  ADD CONSTRAINT space_removal_check CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND remover_role IS NULL AND removal_reason IS NULL AND state = 'active')
    OR (removed_at IS NOT NULL AND remover_role IS NOT NULL));

ALTER TABLE community.realm
  DROP CONSTRAINT realm_state_check,
  ADD CONSTRAINT realm_state_check CHECK (state IN ('active', 'removed')),
  ADD COLUMN lifecycle_version bigint NOT NULL DEFAULT 0 CHECK (lifecycle_version >= 0),
  ADD COLUMN removed_at timestamptz,
  ADD COLUMN removed_by uuid,
  ADD COLUMN remover_role text CHECK (remover_role IN ('owner', 'moderator')),
  ADD COLUMN removal_reason text CHECK (char_length(removal_reason) BETWEEN 1 AND 1024),
  ADD CONSTRAINT realm_removal_check CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND remover_role IS NULL AND removal_reason IS NULL AND state = 'active')
    OR (removed_at IS NOT NULL AND remover_role IS NOT NULL));

ALTER TABLE community.party_locator DROP CONSTRAINT party_locator_kind_check,
  ADD CONSTRAINT party_locator_kind_check CHECK (kind IN
    ('ban_target', 'ban_actor', 'membership_operation', 'verdict', 'space_remover', 'realm_remover'));

-- migrate:down
-- Forward only: removal provenance and binding fences must survive rollback.
