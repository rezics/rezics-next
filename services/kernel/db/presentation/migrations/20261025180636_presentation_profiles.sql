-- migrate:up
CREATE SCHEMA presentation;

CREATE TABLE presentation.profile (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  body jsonb NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, digest)
);

CREATE TABLE presentation.profile_activation (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  head integer NOT NULL CHECK (head >= 1),
  digest text NOT NULL,
  recorded_transaction_id uuid NOT NULL,
  PRIMARY KEY (route, head),
  FOREIGN KEY (route, digest) REFERENCES presentation.profile (route, digest)
);

-- migrate:down
DROP TABLE presentation.profile_activation;
DROP TABLE presentation.profile;
DROP SCHEMA presentation;
