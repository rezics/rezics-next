-- Imported private reviews remain reader-owned and never enter public review feeds.
CREATE TABLE reader.private_import_review (
  agent text NOT NULL CHECK (agent ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  work text NOT NULL CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$'),
  spoiler boolean NOT NULL DEFAULT false,
  version bigint NOT NULL CHECK (version > 0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent, work)
);

CREATE TABLE reader.private_import_review_command (
  agent text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent, idempotency_key)
);
