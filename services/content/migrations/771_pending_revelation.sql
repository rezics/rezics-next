-- A relation write registers its revelation here before the graph write, keyed by the write's receipt.
-- Readers treat a pending record as position-required, so it stays hidden until publication or refusal
-- removes exactly this receipt's row. A crash leaves the row, which fails closed; replaying the same
-- Idempotency-Key publishes (graph accepted) or clears (graph refused) it.
CREATE TABLE reading_position.pending_revelation (
  record text NOT NULL CHECK (record ~ '^https://rezics[.]com/id/[0-9a-f-]{36}$'),
  receipt text NOT NULL CHECK (receipt <> ''),
  PRIMARY KEY (receipt, record)
);
CREATE INDEX pending_revelation_record ON reading_position.pending_revelation (record);
