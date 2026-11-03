-- migrate:up
-- Imported aggregate observations deliberately have no voter, question or native aggregate key.
CREATE TABLE rating.source_classification_observation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  association_key text NOT NULL CHECK (association_key ~ '^[0-9a-f]{64}$'),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  association jsonb NOT NULL CHECK (jsonb_typeof(association) = 'object'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 8192),
  as_of timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, association_key, digest),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  CHECK (route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)),
  CHECK (association->>'subjectId' = subject_id::text)
);
CREATE TABLE rating.source_classification_slot (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  association_key text NOT NULL,
  digest text,
  PRIMARY KEY (route, subject_id, association_key),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  FOREIGN KEY (route, subject_id, association_key, digest)
    REFERENCES rating.source_classification_observation (route, subject_id, association_key, digest)
);

-- migrate:down
-- Forward only: immutable observations and ordered clear heads must survive rollback.
