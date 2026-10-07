-- Durable preparation precedes the graph commit. Receipt and owner outbox
-- become terminal together only after its exact object and graph proof match.
CREATE TABLE access.command_custody (
  receipt text PRIMARY KEY,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload bytea NOT NULL,
  revision text NOT NULL UNIQUE,
  terminal jsonb,
  outbox jsonb,
  reconciled_at timestamptz,
  retired_at timestamptz,
  CHECK ((terminal IS NULL) = (outbox IS NULL)),
  CHECK ((terminal IS NULL) = (reconciled_at IS NULL)),
  CHECK (retired_at IS NULL OR reconciled_at IS NOT NULL)
);
