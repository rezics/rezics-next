-- migrate:up
ALTER TABLE economy.command_receipt DROP CONSTRAINT command_receipt_outcome_check;
ALTER TABLE economy.command_receipt ADD CONSTRAINT command_receipt_outcome_check CHECK (outcome IN (
  'ok', 'asset_missing', 'operation_conflict', 'insufficient_funds', 'asset_not_transferable',
  'hold_missing', 'hold_closed', 'allocation_missing', 'allocation_closed', 'invalid_amount', 'invalid_operation'
));

ALTER TABLE economy.journal DROP CONSTRAINT journal_kind_check, DROP CONSTRAINT journal_check1;
ALTER TABLE economy.journal ADD CONSTRAINT journal_kind_check CHECK (kind IN (
  'issue', 'transfer', 'reserve', 'capture', 'release', 'expire', 'release_amount',
  'allocate', 'capture_allocation', 'release_allocation'
));
ALTER TABLE economy.journal ADD CONSTRAINT journal_hold_kind_check
  CHECK ((kind NOT IN ('issue', 'transfer')) = (hold_id IS NOT NULL));

ALTER TABLE economy.hold ADD COLUMN allocated bigint NOT NULL DEFAULT 0 CHECK (allocated BETWEEN 0 AND remaining);
DROP INDEX economy.hold_due_idx;
CREATE INDEX hold_due_idx ON economy.hold (book_id, expires_at, asset_id, account_id, hold_id) WHERE remaining > allocated;

CREATE TABLE economy.hold_allocation (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  account_id uuid NOT NULL,
  hold_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('spot_fill', 'market_trade', 'withdrawal')),
  reference text NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 255),
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('protected', 'captured', 'released')),
  recipient_id uuid,
  allocation_transaction_id uuid NOT NULL,
  allocated_at timestamptz NOT NULL,
  terminal_transaction_id uuid,
  resolved_at timestamptz,
  PRIMARY KEY (book_id, asset_id, account_id, hold_id, purpose, reference),
  UNIQUE (book_id, asset_id, allocation_transaction_id),
  UNIQUE (book_id, asset_id, terminal_transaction_id),
  FOREIGN KEY (book_id, asset_id, account_id, hold_id) REFERENCES economy.hold,
  FOREIGN KEY (book_id, asset_id, allocation_transaction_id) REFERENCES economy.journal,
  FOREIGN KEY (book_id, asset_id, terminal_transaction_id) REFERENCES economy.journal,
  CHECK ((status = 'captured') = (recipient_id IS NOT NULL)),
  CHECK ((status = 'protected') = (terminal_transaction_id IS NULL)),
  CHECK ((terminal_transaction_id IS NULL) = (resolved_at IS NULL))
);

-- migrate:down
-- Forward only: protected allocations and recorded economic outcomes must be preserved.
