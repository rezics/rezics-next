-- migrate:up
CREATE TABLE economy.market_repair_request (
  transaction_id uuid PRIMARY KEY,
  book_id text NOT NULL,
  node text NOT NULL CHECK (length(btrim(node)) > 0 AND length(node) <= 255),
  item_home_id text NOT NULL,
  trade_id text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  claim_id uuid,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  last_failure text CHECK (last_failure IN ('owner_retry', 'unavailable')),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('completed', 'not_found')),
  FOREIGN KEY (book_id, trade_id) REFERENCES economy.market_trade (book_id, trade_id),
  CHECK ((finished_at IS NULL) = (outcome IS NULL)),
  CHECK (finished_at IS NULL OR (claim_id IS NULL AND last_failure IS NULL))
);

CREATE INDEX market_repair_ready_idx ON economy.market_repair_request
  (book_id, node, item_home_id, available_at, transaction_id)
  WHERE finished_at IS NULL;

-- migrate:down
-- Forward only: accepted repair requests and their command bindings survive upgrade.
