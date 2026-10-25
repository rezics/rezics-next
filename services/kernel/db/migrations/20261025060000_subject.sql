-- migrate:up
CREATE SCHEMA semantic;

CREATE TABLE semantic.subject (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  type text NOT NULL CHECK (type = 'schema:Book'),
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id),
  CHECK (
    route = get_byte(uuid_send(subject_id), 10) * 256 + get_byte(uuid_send(subject_id), 11)
  )
);

CREATE TABLE semantic.fact (
  route integer NOT NULL,
  subject_id uuid NOT NULL,
  slot_id uuid NOT NULL,
  log_seq integer NOT NULL CHECK (log_seq BETWEEN 1 AND 32),
  operation text NOT NULL CHECK (operation IN ('assert', 'retract')),
  kind text NOT NULL CHECK (kind IN ('label', 'description', 'alias', 'statement')),
  language text,
  property text,
  statement_id uuid,
  body jsonb NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, subject_id, slot_id, log_seq),
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject (route, subject_id),
  CHECK (
    (kind IN ('label', 'description', 'alias') AND language IS NOT NULL AND property IS NULL AND statement_id IS NULL)
    OR (kind = 'statement' AND language IS NULL AND property IS NOT NULL AND statement_id IS NOT NULL)
  )
);

-- migrate:down
DROP TABLE semantic.fact;
DROP TABLE semantic.subject;
DROP SCHEMA semantic;
