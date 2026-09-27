-- Reader-owned status is exclusive per person Agent and Work. A cleared row keeps
-- its version so stale commands cannot recreate an older shelf position.
CREATE TABLE reader.library_status (
  agent text NOT NULL CHECK (agent ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  work text NOT NULL CHECK (work ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  status text CHECK (status IN ('want-to-read', 'reading', 'read')),
  started_on date,
  finished_on date,
  version bigint NOT NULL CHECK (version > 0),
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent, work),
  CONSTRAINT library_status_dates CHECK (
    (status = 'read' AND (started_on IS NULL OR finished_on IS NULL OR started_on <= finished_on))
    OR (status IS DISTINCT FROM 'read' AND started_on IS NULL AND finished_on IS NULL))
);
CREATE INDEX library_status_shelf ON reader.library_status (agent, status, changed_at DESC, work DESC)
  WHERE status IS NOT NULL;

CREATE TABLE reader.library_status_command (
  agent text NOT NULL,
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9:_./-]{1,128}$'),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent, idempotency_key)
);
