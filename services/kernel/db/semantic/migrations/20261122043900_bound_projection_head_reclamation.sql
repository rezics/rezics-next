-- migrate:up
CREATE TABLE semantic.public_filter_projection_reclamation (
  partition_no integer NOT NULL,
  subject_id uuid NOT NULL,
  build_id uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  successor uuid NOT NULL CHECK (successor <> build_id),
  meaning_digest text NOT NULL,
  source_key text NOT NULL,
  source jsonb NOT NULL,
  heads jsonb NOT NULL,
  input_limit integer NOT NULL CHECK (input_limit BETWEEN 1 AND 1000),
  step integer NOT NULL CHECK (step BETWEEN 0 AND 4096),
  PRIMARY KEY (partition_no, subject_id),
  FOREIGN KEY (partition_no, subject_id)
    REFERENCES semantic.public_filter_projection_build (partition_no, subject_id) ON DELETE CASCADE
);

-- migrate:down
DROP TABLE semantic.public_filter_projection_reclamation;
