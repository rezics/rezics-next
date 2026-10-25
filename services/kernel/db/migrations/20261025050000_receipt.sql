-- migrate:up
CREATE SCHEMA editorial;

CREATE TABLE core.receipt (
  partition_no integer NOT NULL REFERENCES core.partition (partition_no),
  actor_account_id uuid NOT NULL,
  command_kind text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
  epoch integer NOT NULL CHECK (epoch > 0),
  position bigint NOT NULL CHECK (position > 0),
  transaction_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (partition_no, actor_account_id, command_kind, idempotency_key)
);

CREATE TABLE editorial.write_basis (
  partition_no integer NOT NULL REFERENCES core.partition (partition_no),
  transaction_id uuid NOT NULL,
  epoch integer NOT NULL CHECK (epoch > 0),
  position bigint NOT NULL CHECK (position > 0),
  actor_account_id uuid NOT NULL,
  client_id text NOT NULL,
  requested_by text,
  recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (partition_no, transaction_id),
  UNIQUE (partition_no, position)
);

-- migrate:down
DROP TABLE editorial.write_basis;
DROP TABLE core.receipt;
DROP SCHEMA editorial;
