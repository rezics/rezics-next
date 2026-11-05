-- migrate:up
ALTER TABLE access.account
  ADD COLUMN handle_change_times timestamptz[] NOT NULL DEFAULT '{}'::timestamptz[],
  ADD CONSTRAINT account_handle_change_times_check CHECK (cardinality(handle_change_times) <= 5);

ALTER TABLE access.handle_claim
  ADD COLUMN former_until timestamptz;

-- Existing reservations already represent renamed or deleted handles. Keep their
-- allocation records and carry the former forwarding deadline into its own field.
UPDATE access.handle_claim
SET former_until = reserved_until
WHERE state = 'reserved';

-- Existing reservations carry the end of the old 30-day redirect window. Recover
-- the latest retained rename times so the rolling limit also covers active accounts.
WITH ranked_changes AS (
  SELECT h.account_id, h.reserved_until - INTERVAL '30 days' AS changed_at,
         row_number() OVER (PARTITION BY h.account_id ORDER BY h.reserved_until DESC) AS change_order
  FROM access.handle_claim h
  WHERE h.state = 'reserved'
), recent_changes AS (
  SELECT account_id, array_agg(changed_at ORDER BY changed_at) AS times
  FROM ranked_changes
  WHERE change_order <= 5
  GROUP BY account_id
)
UPDATE access.account a
SET handle_change_times = recent_changes.times
FROM recent_changes
WHERE a.account_id = recent_changes.account_id AND a.state = 'active';

ALTER TABLE access.handle_claim
  ADD CONSTRAINT handle_claim_former_until_check
    CHECK (former_until IS NULL OR state IN ('pending', 'reserved'));

-- migrate:down
-- Forward only: retired handles and rename limits are durable account policy.
