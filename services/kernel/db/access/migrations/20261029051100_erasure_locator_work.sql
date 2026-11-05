-- migrate:up
CREATE TABLE access.erasure_locator_work (
  workflow_id text PRIMARY KEY,
  effect text NOT NULL,
  opened_at bigint NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'done', 'resolved')),
  resolution_transaction_id uuid,
  CHECK ((state = 'resolved') = (resolution_transaction_id IS NOT NULL))
);
-- The state constraint makes excluding the two terminal states exactly the open set.
-- This also avoids estimating an unknown text equality as one row before the first ANALYZE.
CREATE INDEX erasure_locator_work_open ON access.erasure_locator_work (opened_at)
  WHERE state <> 'done' AND state <> 'resolved';
-- Initialize the empty partial index's page estimate before relay delivery begins.
ANALYZE access.erasure_locator_work;

-- migrate:down
DROP TABLE access.erasure_locator_work;
