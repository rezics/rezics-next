-- migrate:up
ALTER TABLE core.outbox ADD COLUMN payload_state text NOT NULL DEFAULT 'present'
  CHECK (payload_state IN ('present','minimized'));
ALTER TABLE core.outbox ADD CONSTRAINT outbox_minimized_payload
  CHECK (payload_state <> 'minimized' OR (data='{}'::jsonb AND subject IS NULL));

-- Extend the existing native job; the default worker no longer starts a preference-only execution.
ALTER TABLE core.preference_history_job
  ADD COLUMN scan_partition integer NOT NULL DEFAULT 0 CHECK(scan_partition BETWEEN 0 AND 4096),
  ADD COLUMN scan_type text COLLATE "C",
  ADD COLUMN scan_locator bytea CHECK(octet_length(scan_locator) BETWEEN 1 AND 256),
  ADD COLUMN phase text NOT NULL DEFAULT 'scan' CHECK(phase IN ('scan','pending')),
  ADD COLUMN applicable boolean NOT NULL DEFAULT false,
  ADD COLUMN next_run timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN gap text CHECK(octet_length(gap)<=2048),
  ADD CONSTRAINT history_job_cursor CHECK((scan_type IS NULL)=(scan_locator IS NULL));
CREATE INDEX preference_history_runnable ON core.preference_history_job(next_run,job_id) WHERE phase='scan';
CREATE UNIQUE INDEX preference_history_barrier ON core.preference_history_job(account_route,account_id,barrier_id);
ALTER TABLE core.history_progress ADD COLUMN coverage_gap text CHECK(octet_length(coverage_gap)<=2048);

-- Owner dispositions outlive DBOS history. An effects checkpoint proves enqueue only.
CREATE TABLE core.history_event_consumer (
  partition_no integer NOT NULL REFERENCES core.partition(partition_no),
  position bigint NOT NULL CHECK(position>0), event_seq integer NOT NULL CHECK(event_seq BETWEEN 0 AND 999),
  consumer text COLLATE "C" NOT NULL CHECK(consumer ~ '^[a-z][a-z0-9_]{0,62}$'),
  workflow_id text NOT NULL CHECK(octet_length(workflow_id)<=256),
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','completed','transferred','suppressed')),
  PRIMARY KEY(partition_no,position,event_seq,consumer), UNIQUE(workflow_id)
);

ALTER TABLE core.history_work
  ADD COLUMN owner text CHECK(owner ~ '^[a-z][a-z0-9_.-]{0,95}$'),
  ADD COLUMN request jsonb CHECK(octet_length(request::text)<=65536),
  ADD COLUMN scope jsonb CHECK(octet_length(scope::text)<=16384),
  ADD COLUMN source_partition integer CHECK(source_partition BETWEEN 0 AND 4095),
  ADD COLUMN source_transaction uuid,
  ADD COLUMN admitted boolean NOT NULL DEFAULT false,
  ADD COLUMN absence_verified boolean NOT NULL DEFAULT false;
CREATE INDEX history_work_source ON core.history_work(source_partition,work_id);

-- migrate:down
-- Forward only: minimized payloads and permanent retired identities cannot be restored.
