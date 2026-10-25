-- migrate:up
CREATE SCHEMA IF NOT EXISTS library;

CREATE TABLE library.entry (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  requested_subject_id uuid,
  state text NOT NULL CHECK (state IN ('planned', 'in_progress', 'completed', 'paused', 'dropped')),
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, account_id, subject_id),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

CREATE INDEX entry_account_updated ON library.entry (route, account_id, updated_at DESC, subject_id);
CREATE INDEX entry_account_state ON library.entry (route, account_id, state, updated_at DESC, subject_id);

CREATE TABLE library.copy (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  copy_id uuid NOT NULL,
  account_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('ordered', 'owned', 'lent', 'disposed')),
  location text CHECK (location IS NULL OR char_length(location) <= 200),
  source text CHECK (source IS NULL OR char_length(source) <= 200),
  acquired_on date,
  disposed_on date,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, copy_id),
  CHECK (route = get_byte(uuid_send(copy_id), 10) * 256 + get_byte(uuid_send(copy_id), 11)),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11))
);

CREATE INDEX copy_account_created ON library.copy (route, account_id, created_at, copy_id);

-- migrate:down
-- Forward only: a person's library entries and copies must not be discarded by rollback.
