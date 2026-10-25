-- migrate:up
CREATE TABLE semantic.context (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  context_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('global', 'community')),
  labels jsonb NOT NULL,
  recorded_transaction_id uuid,
  PRIMARY KEY (route, context_id),
  CHECK (
    route = get_byte(uuid_send(context_id), 10) * 256 + get_byte(uuid_send(context_id), 11)
  )
);

INSERT INTO semantic.context (route, context_id, kind, labels)
VALUES (0, '00000000-0000-8000-8000-000000000000', 'global', '{"en":"Global"}');

CREATE TABLE semantic.definition_release (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  body jsonb NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, digest)
);

CREATE TABLE semantic.definition_activation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  head integer NOT NULL CHECK (head >= 1),
  digest text NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, head),
  FOREIGN KEY (route, digest) REFERENCES semantic.definition_release (route, digest)
);

-- migrate:down
DROP TABLE semantic.definition_activation;
DROP TABLE semantic.definition_release;
DROP TABLE semantic.context;
