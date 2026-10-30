-- migrate:up
-- Positive locators only. Creator-home offers and Content remain authoritative.
CREATE TABLE commerce.subject_offer_reference (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  original_subject_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  identity_epoch bigint NOT NULL CHECK (identity_epoch > 0),
  listed boolean NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (route, subject_id, offer_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);
CREATE INDEX subject_offer_original ON commerce.subject_offer_reference
  (route, subject_id, original_subject_id, offer_id);
-- One raw source home at a time, without sorting or scanning other homes.
CREATE INDEX offer_discovery_source ON commerce.offer ((route >> 4), offer_id);
CREATE TABLE commerce.subject_offer_bootstrap (
  partition_no integer PRIMARY KEY CHECK (partition_no = 0),
  frontier text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  ready boolean NOT NULL DEFAULT false
);
INSERT INTO commerce.subject_offer_bootstrap (partition_no, frontier)
VALUES (0, '0/00000000-0000-0000-0000-000000000000');

-- migrate:down
DROP TABLE commerce.subject_offer_bootstrap;
DROP INDEX commerce.offer_discovery_source;
DROP TABLE commerce.subject_offer_reference;
