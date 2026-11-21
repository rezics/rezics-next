-- migrate:up
ALTER TABLE economy.funding_dispatch
  ADD COLUMN test_lane text CHECK (test_lane ~ '^[0-9a-f]{64}$');

CREATE INDEX funding_dispatch_test_due_idx ON economy.funding_dispatch (book_id, test_lane, due_at, intent_id)
  WHERE closed_at IS NULL AND test_lane IS NOT NULL;

-- migrate:down
ALTER TABLE economy.funding_dispatch DROP COLUMN test_lane;
