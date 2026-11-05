-- migrate:up
CREATE SCHEMA zones;
CREATE TABLE zones.zone (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  zone_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  state text NOT NULL CHECK (state IN ('active', 'deleted', 'purge_pending', 'purged')),
  owner_id uuid,
  visibility text NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
  configuration jsonb,
  mounts uuid[] DEFAULT '{}',
  release_digest text NOT NULL,
  public_ever boolean NOT NULL DEFAULT false,
  write_fenced boolean NOT NULL DEFAULT false,
  lifecycle_revision bigint NOT NULL DEFAULT 1 CHECK (lifecycle_revision > 0),
  withholding jsonb NOT NULL DEFAULT '{}',
  held boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  restore_until timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  creation_transaction_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, zone_id),
  CHECK (route = get_byte(uuid_send(zone_id), 10) * 256 + get_byte(uuid_send(zone_id), 11)),
  CHECK (owner_id IS NULL OR route = get_byte(uuid_send(owner_id), 10) * 256 + get_byte(uuid_send(owner_id), 11)),
  CHECK (cardinality(mounts) <= 16),
  CHECK ((deleted_at IS NULL) = (restore_until IS NULL))
);
CREATE INDEX zone_owner_keys ON zones.zone (route, owner_id, state, zone_id);

-- migrate:down
-- Forward only: resource heads and retained payload must survive rollback.
