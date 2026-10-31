-- migrate:up
-- A repair retry resolves the exact original Source page without rebuilding mutable current rows.
CREATE TABLE semantic.public_filter_projection_replay (
  partition_no integer NOT NULL DEFAULT 0 CHECK (partition_no = 0),
  bootstrap uuid NOT NULL,
  execution text NOT NULL CHECK (octet_length(execution) BETWEEN 1 AND 4096),
  predecessor text NOT NULL CHECK (predecessor = '' OR predecessor ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  subject_id uuid NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  page_data text NOT NULL,
  page_digest text NOT NULL CHECK (page_digest ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (partition_no, bootstrap, execution, predecessor, route, subject_id, request_digest),
  FOREIGN KEY (partition_no, bootstrap)
    REFERENCES semantic.public_filter_bootstrap(partition_no, bootstrap) ON DELETE CASCADE,
  FOREIGN KEY (route, subject_id) REFERENCES semantic.subject(route, subject_id),
  CHECK (route >= partition_no * 16 AND route < (partition_no + 1) * 16)
);

-- migrate:down
DROP TABLE semantic.public_filter_projection_replay;
