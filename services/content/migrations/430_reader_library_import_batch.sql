CREATE TABLE reader.library_import_batch (
  agent text NOT NULL CHECK (agent ~ '^https://rezics.com/id/[0-9a-f-]{36}$'),
  import_key text NOT NULL CHECK (length(import_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  row_count integer NOT NULL CHECK (row_count BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent, import_key)
);
CREATE TABLE reader.library_import_row_outcome (
  agent text NOT NULL,
  import_key text NOT NULL,
  row_number integer NOT NULL CHECK (row_number >= 0),
  outcome jsonb NOT NULL CHECK (jsonb_typeof(outcome) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (agent, import_key, row_number),
  FOREIGN KEY (agent, import_key) REFERENCES reader.library_import_batch (agent, import_key)
);
CREATE TABLE reader.library_import_step (
  agent text NOT NULL,
  import_key text NOT NULL,
  row_number integer NOT NULL CHECK (row_number >= 0),
  step_key text NOT NULL CHECK (length(step_key) BETWEEN 1 AND 100),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  completed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (agent, import_key, row_number, step_key),
  FOREIGN KEY (agent, import_key) REFERENCES reader.library_import_batch (agent, import_key)
);
