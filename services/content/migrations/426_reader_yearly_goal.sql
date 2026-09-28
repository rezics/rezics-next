CREATE TABLE reader.yearly_goal (
  agent text NOT NULL CHECK (agent ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  year integer NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  target integer CHECK (target BETWEEN 1 AND 1000),
  version bigint NOT NULL CHECK (version > 0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent, year)
);

CREATE TABLE reader.yearly_goal_command (
  agent text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent, idempotency_key)
);

CREATE INDEX library_status_finished_year ON reader.library_status (agent, finished_on)
  WHERE status = 'read' AND finished_on IS NOT NULL;
