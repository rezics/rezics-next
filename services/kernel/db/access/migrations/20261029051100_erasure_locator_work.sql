-- migrate:up
CREATE TABLE access.erasure_locator_work (
  workflow_id text PRIMARY KEY,
  effect text NOT NULL,
  opened_at bigint NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'resolved')),
  resolution_transaction_id uuid,
  CHECK ((state = 'resolved') = (resolution_transaction_id IS NOT NULL))
);
CREATE INDEX erasure_locator_work_open ON access.erasure_locator_work (opened_at) WHERE state = 'open';
-- Initialize the empty partial index's page estimate before the relay starts filling the table.
ANALYZE access.erasure_locator_work;

-- migrate:down
DROP TABLE access.erasure_locator_work;
