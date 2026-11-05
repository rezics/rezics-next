-- migrate:up
-- Private access-path keys only: neither support nor directory existence grants access or proves membership.
CREATE TABLE library.builtin_collection_reference (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  collection_id uuid NOT NULL,
  account_id uuid NOT NULL,
  profile_id text NOT NULL CHECK (
    octet_length(profile_id) BETWEEN 1 AND 64 AND profile_id COLLATE "C" ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'),
  state_set_id text NOT NULL CHECK (
    octet_length(state_set_id) BETWEEN 1 AND 64 AND state_set_id COLLATE "C" ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'),
  state_id text NOT NULL CHECK (
    octet_length(state_id) BETWEEN 1 AND 64 AND state_id COLLATE "C" ~ '\A[a-z][a-z0-9_.-]{0,63}\Z'),
  PRIMARY KEY (route, collection_id),
  UNIQUE (route, account_id, profile_id, state_set_id, state_id),
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

CREATE TABLE library.builtin_state_reference_source (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  source_transaction_id uuid NOT NULL,
  release_digest text NOT NULL CHECK (
    octet_length(release_digest) = 71 AND release_digest COLLATE "C" ~ '\Asha256:[0-9a-f]{64}\Z'),
  PRIMARY KEY (route, account_id, subject_id),
  FOREIGN KEY (route, collection_id) REFERENCES library.builtin_collection_reference (route, collection_id)
    ON DELETE NO ACTION,
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

-- Bounded supporting-reference seek and cleanup. Account purge erases children before directory parents.
CREATE INDEX builtin_state_reference_source_support
  ON library.builtin_state_reference_source USING btree (route, collection_id, subject_id);

-- migrate:down
-- Forward only: empty-support keys may remain private until bounded cleanup.
