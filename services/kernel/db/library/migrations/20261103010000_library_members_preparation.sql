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
  canonical_basis text NOT NULL CHECK (octet_length(canonical_basis) <= 196608),
  basis_digest bytea NOT NULL CHECK (octet_length(basis_digest) = 32),
  state text NOT NULL CHECK (state IN ('live', 'retired')),
  last_read_at timestamptz NOT NULL,
  workflow_id text NOT NULL,
  progress_version bigint NOT NULL DEFAULT 0 CHECK (progress_version >= 0),
  checkpoint text,
  observation jsonb,
  source_incarnation text,
  source_generation text,
  reserved_incarnation text NOT NULL CHECK (octet_length(reserved_incarnation) <= 256),
  reserved_generation text NOT NULL CHECK (octet_length(reserved_generation) <= 256),
  complete boolean NOT NULL DEFAULT false,
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count >= 0),
  failure_code text,
  PRIMARY KEY (route, owner_account_id, collection_id, episode_id),
  CHECK (route = get_byte(uuid_send(owner_account_id), 10) * 256 + get_byte(uuid_send(owner_account_id), 11)),
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK (route = get_byte(uuid_send(episode_id), 10) * 256 + get_byte(uuid_send(episode_id), 11)),
  CHECK (source_incarnation IS NULL OR octet_length(source_incarnation) <= 256),
  CHECK (octet_length(reserved_incarnation) <= 256),
  CHECK (octet_length(reserved_generation) <= 256),
  CHECK ((complete = false) OR (failure_code IS NULL)),
);

CREATE UNIQUE INDEX members_preparation_live_digest
  ON library.members_preparation(route, owner_account_id, basis_digest) WHERE state = 'live';
CREATE INDEX members_preparation_live_lru
  ON library.members_preparation(route, owner_account_id, last_read_at, episode_id) WHERE state = 'live';
CREATE INDEX members_preparation_retired_cleanup
  ON library.members_preparation(route, owner_account_id, collection_id, episode_id) WHERE state = 'retired';

CREATE TABLE library.members_preparation_result (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  owner_account_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  episode_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  sort_key text NOT NULL,
  PRIMARY KEY (route, owner_account_id, collection_id, episode_id, subject_id),
  UNIQUE (route, owner_account_id, collection_id, episode_id, sort_key, subject_id),
  CHECK (route = get_byte(uuid_send(owner_account_id), 10) * 256 + get_byte(uuid_send(owner_account_id), 11)),
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK (route = get_byte(uuid_send(episode_id), 10) * 256 + get_byte(uuid_send(episode_id), 11)),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  FOREIGN KEY (route, owner_account_id, collection_id, episode_id)
    REFERENCES library.members_preparation(route, owner_account_id, collection_id, episode_id)
);
CREATE INDEX members_preparation_result_page
  ON library.members_preparation_result(route, owner_account_id, collection_id, episode_id, sort_key, subject_id);

COMMENT ON TABLE library.members_preparation_owner IS
  'Maintained per-owner live episode quota and LRU serialization point. live_count is changed only with episode admission or retirement; it is never reconstructed from result/history rows.';
COMMENT ON TABLE library.members_preparation IS
  'Private disposable filter preparation. canonical_basis is retained exactly beside its lookup digest. A header, workflow status, or selected History result is not Source, authorization, or disclosure authority.';
COMMENT ON TABLE library.members_preparation_result IS
  'Private derived output candidates. Rows remain subordinate to the current header and actual Source; ordinary disclosure is revalidated before use.';

-- migrate:down
-- Forward-only: retained work, result and erasure inventories require an explicit fenced retirement.
