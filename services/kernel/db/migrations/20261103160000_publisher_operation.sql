-- migrate:up
CREATE TABLE core.publisher_operation (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no) CHECK (partition_no = 0),
  original_key text NOT NULL CHECK (original_key ~ '^[a-f0-9]{64}$'),
  input_digest text NOT NULL CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  result_digest text CHECK (result_digest ~ '^sha256:[a-f0-9]{64}$'),
  result_bytes bytea CHECK (octet_length(result_bytes) <= 65536),
  epoch integer CHECK (epoch > 0),
  position bigint CHECK (position > 0),
  transaction_id uuid,
  retain_until timestamptz NOT NULL,
  PRIMARY KEY (partition_no, original_key),
  CHECK ((transaction_id IS NULL AND epoch IS NULL AND position IS NULL AND result_digest IS NULL AND result_bytes IS NULL)
      OR (transaction_id IS NOT NULL AND epoch IS NOT NULL AND position IS NOT NULL AND result_digest IS NOT NULL))
);
CREATE INDEX publisher_operation_retention ON core.publisher_operation(partition_no,retain_until,original_key)
  WHERE result_bytes IS NOT NULL;

-- migrate:down
DROP TABLE core.publisher_operation;
