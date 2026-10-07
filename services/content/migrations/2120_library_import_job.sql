CREATE TABLE reader.library_import_job (
  agent text NOT NULL,
  file_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','completed','stalled','failed')),
  reason text CHECK (reason IN ('no-progress','lease-expired','owner-refused','apply-failed','worker-stopped')),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_progress_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent,file_id),
  FOREIGN KEY (agent,file_id) REFERENCES reader.library_import_file(agent,id) ON DELETE CASCADE,
  CHECK ((state IN ('stalled','failed')) = (reason IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((state = 'pending') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX library_import_job_deadline ON reader.library_import_job(lease_expires_at,last_progress_at)
  WHERE state='pending';
CREATE TABLE reader.library_import_apply_command (
  agent text NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  file_id uuid NOT NULL,
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  PRIMARY KEY (agent,idempotency_key),
  FOREIGN KEY (agent,file_id) REFERENCES reader.library_import_file(agent,id) ON DELETE CASCADE
);
