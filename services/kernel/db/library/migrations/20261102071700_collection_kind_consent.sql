-- migrate:up
CREATE TABLE library.collection_kind_consent_consumer (
  route integer NOT NULL,
  reference_id text NOT NULL,
  owner_account_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  preparation_id uuid NOT NULL,
  origin_id text NOT NULL,
  source_generation bigint NOT NULL,
  capture_generation uuid NOT NULL,
  source_capture text NOT NULL,
  enrollment_generation uuid NOT NULL,
  catalogue_root text NOT NULL,
  restore_generation bigint NOT NULL DEFAULT 0,
  invalidated boolean NOT NULL DEFAULT false,
  last_transition_id text,
  PRIMARY KEY (route, reference_id),
  UNIQUE (route, owner_account_id, collection_id, preparation_id, origin_id),
  CHECK (route BETWEEN 0 AND 65535),
  CHECK (route = (get_byte(uuid_send(owner_account_id), 10) * 256 + get_byte(uuid_send(owner_account_id), 11))),
  CHECK (route = (get_byte(uuid_send(collection_id), 10) * 256 + get_byte(uuid_send(collection_id), 11))),
  CHECK (route = (get_byte(uuid_send(preparation_id), 10) * 256 + get_byte(uuid_send(preparation_id), 11))),
  CHECK (octet_length(reference_id) BETWEEN 1 AND 255),
  CHECK (octet_length(origin_id) BETWEEN 1 AND 255),
  CHECK (octet_length(source_capture) BETWEEN 1 AND 4096),
  CHECK (octet_length(catalogue_root) BETWEEN 1 AND 128),
  CHECK (source_generation >= 0),
  CHECK (restore_generation >= 0),
  CHECK (last_transition_id IS NULL OR octet_length(last_transition_id) BETWEEN 1 AND 255)
);

CREATE TABLE library.collection_kind_consent_transition (
  route integer NOT NULL,
  reference_id text NOT NULL,
  transition_id text NOT NULL,
  enrollment_generation uuid NOT NULL,
  restore_generation bigint NOT NULL,
  receipt_reference text NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (route, reference_id, transition_id),
  FOREIGN KEY (route, reference_id)
    REFERENCES library.collection_kind_consent_consumer(route, reference_id) ON DELETE CASCADE,
  CHECK (octet_length(transition_id) BETWEEN 1 AND 255),
  CHECK (octet_length(receipt_reference) BETWEEN 1 AND 255),
  CHECK (restore_generation >= 0),
  CHECK (status IN ('committed'))
);

CREATE INDEX collection_kind_consent_consumer_owner
  ON library.collection_kind_consent_consumer(route, owner_account_id, collection_id, preparation_id);

CREATE INDEX collection_kind_consent_transition_pending
  ON library.collection_kind_consent_transition(route, reference_id, transition_id)
  WHERE status <> 'committed';

-- Account erasure pages the owned receiving references in exact native-key order.
CREATE INDEX collection_kind_consent_consumer_erasure
  ON library.collection_kind_consent_consumer(route, owner_account_id, reference_id);


CREATE INDEX collection_kind_consent_consumer_episode
  ON library.collection_kind_consent_consumer(route,owner_account_id,collection_id,preparation_id,reference_id);

-- migrate:down
DROP TABLE library.collection_kind_consent_transition;
DROP TABLE library.collection_kind_consent_consumer;
