-- Private reader progress follows an occurrence identity, not its target or
-- current order. An optional selected Content revision gives finer precision.
CREATE TABLE structure.progress (
  principal_issuer text NOT NULL CHECK (length(principal_issuer) BETWEEN 1 AND 300),
  principal_subject text NOT NULL CHECK (length(principal_subject) BETWEEN 1 AND 300),
  structure text NOT NULL CHECK (structure ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  occurrence text NOT NULL CHECK (occurrence ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  selection_key text NOT NULL DEFAULT '' CHECK (selection_key = '' OR
    selection_key ~ '^urn:rezics:content:revision:[0-9a-f-]{36}$'),
  completed boolean NOT NULL,
  position text CHECK (position IS NULL OR
    (octet_length(position) BETWEEN 1 AND 500 AND position !~ '[[:cntrl:]]')),
  version bigint NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_issuer, principal_subject, structure, occurrence, selection_key)
);

-- A command key is scoped to the verified principal. Its result is saved in
-- the same transaction as the progress update for exact replay after a lost response.
CREATE TABLE structure.progress_command (
  principal_issuer text NOT NULL,
  principal_subject text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  structure text NOT NULL,
  occurrence text NOT NULL,
  selection_key text NOT NULL,
  result_version bigint NOT NULL CHECK (result_version > 0),
  result_completed boolean NOT NULL,
  result_position text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_issuer, principal_subject, idempotency_key),
  CHECK (structure ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  CHECK (occurrence ~ '^https://rezics\.com/id/[0-9a-f-]{36}$'),
  CHECK (selection_key = '' OR selection_key ~ '^urn:rezics:content:revision:[0-9a-f-]{36}$'),
  CHECK (result_position IS NULL OR
    (octet_length(result_position) BETWEEN 1 AND 500 AND result_position !~ '[[:cntrl:]]'))
);

CREATE FUNCTION structure.progress_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'progress command receipt is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER progress_command_immutable BEFORE UPDATE OR DELETE ON structure.progress_command
  FOR EACH ROW EXECUTE FUNCTION structure.progress_command_guard();
