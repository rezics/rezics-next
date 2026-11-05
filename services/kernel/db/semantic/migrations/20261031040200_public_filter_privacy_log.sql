-- migrate:up
-- Home-local ordered reductions. The command transaction appends the log row and advances its head atomically.
CREATE TABLE semantic.public_filter_privacy_head (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  position bigint NOT NULL DEFAULT 0 CONSTRAINT public_filter_privacy_head_position_check CHECK (position >= 0),
  CONSTRAINT public_filter_privacy_head_pkey PRIMARY KEY (partition_no)
);
INSERT INTO semantic.public_filter_privacy_head (partition_no, position)
SELECT partition_no, 0 FROM core.partition
ON CONFLICT (partition_no) DO NOTHING;
CREATE TABLE semantic.public_filter_privacy_log (
  partition_no integer NOT NULL,
  owner_epoch integer NOT NULL CONSTRAINT public_filter_privacy_log_epoch_check CHECK (owner_epoch > 0),
  position bigint NOT NULL CONSTRAINT public_filter_privacy_log_position_check CHECK (position > 0),
  transaction_id uuid NOT NULL,
  cause text NOT NULL CONSTRAINT public_filter_privacy_log_cause_check
    CHECK (cause IN ('subject', 'candidate', 'selection', 'sourceTuple', 'consent', 'collection')),
  affected jsonb NOT NULL CONSTRAINT public_filter_privacy_log_affected_check CHECK (jsonb_typeof(affected) = 'array'),
  impacts jsonb NOT NULL CONSTRAINT public_filter_privacy_log_impacts_check CHECK (jsonb_typeof(impacts) = 'array'),
  recorded_at timestamp with time zone NOT NULL,
  CONSTRAINT public_filter_privacy_log_pkey PRIMARY KEY (partition_no, position),
  CONSTRAINT public_filter_privacy_log_tx_key UNIQUE (partition_no, transaction_id),
  CONSTRAINT public_filter_privacy_log_head_fkey FOREIGN KEY (partition_no)
    REFERENCES semantic.public_filter_privacy_head(partition_no)
);

-- migrate:down
DROP TABLE semantic.public_filter_privacy_log;
DROP TABLE semantic.public_filter_privacy_head;
