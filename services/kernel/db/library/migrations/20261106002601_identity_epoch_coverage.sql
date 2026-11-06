-- migrate:up
-- Committed ALL-Library discovery seal. Empty registration cannot become this row.
CREATE TABLE library.identity_epoch_coverage (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  job_id uuid NOT NULL,
  job_epoch bigint NOT NULL CHECK (job_epoch > 0),
  transaction_id uuid NOT NULL,
  affected integer NOT NULL CHECK (affected >= 0 AND affected <= 65536),
  exhausted boolean NOT NULL,
  PRIMARY KEY (partition_no, job_id, job_epoch)
);

-- migrate:down
DROP TABLE library.identity_epoch_coverage;
