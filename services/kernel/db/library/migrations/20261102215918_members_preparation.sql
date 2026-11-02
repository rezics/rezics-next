-- migrate:up
CREATE TABLE library.members_preparation_owner (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  owner_account_id uuid NOT NULL,
  live_count integer NOT NULL DEFAULT 0 CHECK (live_count BETWEEN 0 AND 32),
  PRIMARY KEY (route, owner_account_id),
  CHECK (route = get_byte(uuid_send(owner_account_id), 10) * 256 + get_byte(uuid_send(owner_account_id), 11))
);

CREATE TABLE library.members_preparation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  owner_account_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  canonical_basis text NOT NULL,
  basis_digest bytea NOT NULL CHECK (octet_length(basis_digest) = 32),
  filter_document jsonb NOT NULL,
  sort text NOT NULL CHECK (sort IN ('id', 'ordinal')),
  release_digest text NOT NULL,
  release_document jsonb NOT NULL,
  source_identity jsonb,
  source_observation jsonb,
  reserved_incarnation text NOT NULL,
  reserved_generation bigint NOT NULL DEFAULT 1 CHECK (reserved_generation > 0),
  state text NOT NULL CHECK (state IN ('live', 'retired')),
  last_read_at timestamptz NOT NULL,
  workflow_id text NOT NULL CHECK (octet_length(workflow_id) BETWEEN 1 AND 1024),
  PRIMARY KEY (route, owner_account_id, collection_id, episode_id),
  CHECK (route = get_byte(uuid_send(owner_account_id), 10) * 256 + get_byte(uuid_send(owner_account_id), 11)),
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK (route = get_byte(uuid_send(episode_id), 10) * 256 + get_byte(uuid_send(episode_id), 11))
);

CREATE UNIQUE INDEX members_preparation_live_digest
  ON library.members_preparation (route, owner_account_id, basis_digest)
  WHERE state = 'live';
CREATE INDEX members_preparation_live_lru
  ON library.members_preparation (route, owner_account_id, last_read_at, episode_id)
  WHERE state = 'live';

-- migrate:down
-- Forward only: retained preparation inputs are erased through the Library owner lifecycle.
