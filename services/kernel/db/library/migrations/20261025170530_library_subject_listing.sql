-- migrate:up
CREATE TABLE library.subject_collection (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  collection_route integer NOT NULL CHECK (collection_route BETWEEN 0 AND 65535),
  multiplicity integer NOT NULL CHECK (multiplicity >= 1),
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, collection_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (collection_route = get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11))
);

CREATE TABLE library.subject_listing (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  public_collection_count integer NOT NULL CHECK (public_collection_count >= 0),
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);

CREATE INDEX collection_member_subject ON library.collection_member (route, collection_id, subject_id);

-- migrate:down
-- Forward only: subject listings must not be discarded by rollback.
