-- migrate:up
CREATE SCHEMA library;

CREATE TABLE library.collection (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  collection_id uuid NOT NULL,
  curator_account_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR char_length(description) <= 2000),
  visibility text NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
  state text NOT NULL CHECK (state IN ('active', 'deleted')),
  revision integer NOT NULL CHECK (revision >= 1),
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count BETWEEN 0 AND 5000),
  order_epoch integer NOT NULL DEFAULT 0 CHECK (order_epoch >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, collection_id),
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK (route = get_byte(uuid_send(curator_account_id), 10) * 256 + get_byte(uuid_send(curator_account_id), 11))
);

CREATE INDEX collection_curator_listing ON library.collection (route, curator_account_id, collection_id);

CREATE TABLE library.collection_member (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  collection_id uuid NOT NULL,
  member_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  note text CHECK (note IS NULL OR char_length(note) <= 1000),
  ordinal_key text COLLATE "C" NOT NULL CHECK (char_length(ordinal_key) BETWEEN 1 AND 48),
  added_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, collection_id, member_id),
  CONSTRAINT collection_member_ordinal_key UNIQUE (route, collection_id, ordinal_key) DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (route, collection_id) REFERENCES library.collection (route, collection_id),
  CHECK (route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11)),
  CHECK (route = get_byte(uuid_send(member_id), 10) * 256 + get_byte(uuid_send(member_id), 11))
);

-- migrate:down
-- Forward only: curated Collections and their member order must not be discarded by rollback.
