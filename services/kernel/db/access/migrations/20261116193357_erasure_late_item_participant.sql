-- migrate:up
DROP INDEX access.erasure_late_item_open;
CREATE INDEX erasure_late_item_open ON access.erasure_late_item (route, account_id, participant)
  WHERE resolved_at IS NULL;

-- migrate:down
DROP INDEX access.erasure_late_item_open;
CREATE INDEX erasure_late_item_open ON access.erasure_late_item (route, account_id)
  WHERE resolved_at IS NULL;
