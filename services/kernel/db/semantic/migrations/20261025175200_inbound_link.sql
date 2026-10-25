-- migrate:up
CREATE TABLE semantic.inbound_link (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  property text NOT NULL CHECK (char_length(property) >= 1),
  source_subject_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  present boolean NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, property, source_subject_id, statement_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11))
);

CREATE INDEX inbound_link_present
  ON semantic.inbound_link (route, subject_id, property, source_subject_id, statement_id)
  WHERE present;

-- migrate:down
DROP TABLE semantic.inbound_link;
