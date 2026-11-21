-- migrate:up
CREATE TABLE economy.asset_program (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  program_id text NOT NULL CHECK (char_length(program_id) BETWEEN 1 AND 64),
  version bigint NOT NULL CHECK (version > 0),
  issuance_source text NOT NULL CHECK (char_length(issuance_source) BETWEEN 1 AND 64),
  supply_cap bigint NOT NULL CHECK (supply_cap > 0),
  redeemable boolean NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY (book_id, asset_id),
  UNIQUE (book_id, program_id, version),
  UNIQUE (book_id, asset_id, program_id),
  FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset
);

CREATE TABLE economy.asset_program_recipient (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  account_id uuid NOT NULL CHECK (account_id <> '00000000-0000-0000-0000-000000000000'),
  PRIMARY KEY (book_id, asset_id, account_id),
  FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset_program
);

CREATE TABLE economy.asset_program_source (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  program_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mint', 'redeem')),
  source_reference text NOT NULL CHECK (char_length(source_reference) BETWEEN 1 AND 255),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (book_id, program_id, kind, source_reference),
  UNIQUE (book_id, asset_id, transaction_id),
  FOREIGN KEY (book_id, asset_id, program_id) REFERENCES economy.asset_program (book_id, asset_id, program_id),
  FOREIGN KEY (book_id, asset_id, transaction_id) REFERENCES economy.journal (book_id, asset_id, transaction_id)
);

CREATE INDEX position_expirable_credit_idx
  ON economy.position (book_id, asset_id, account_id)
  WHERE account_role = 'wallet' AND posted > 0;

CREATE TRIGGER asset_program_immutable BEFORE UPDATE OR DELETE ON economy.asset_program
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();
CREATE TRIGGER asset_program_source_immutable BEFORE UPDATE OR DELETE ON economy.asset_program_source
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

ALTER TABLE economy.command_receipt DROP CONSTRAINT command_receipt_outcome_check;
ALTER TABLE economy.command_receipt ADD CONSTRAINT command_receipt_outcome_check CHECK (outcome IN (
  'ok', 'asset_missing', 'operation_conflict', 'insufficient_funds', 'asset_not_transferable',
  'hold_missing', 'hold_closed', 'allocation_missing', 'allocation_closed', 'invalid_amount', 'invalid_operation',
  'program_ineligible', 'program_expired', 'program_supply_exceeded'
));

ALTER TABLE economy.journal DROP CONSTRAINT journal_kind_check, DROP CONSTRAINT journal_check;
ALTER TABLE economy.journal ADD CONSTRAINT journal_wallet_kind_check
  CHECK ((kind IN ('transfer', 'redeem')) = (namespace = 'wallet'));
ALTER TABLE economy.journal ADD CONSTRAINT journal_kind_check CHECK (kind IN (
  'issue', 'transfer', 'reserve', 'capture', 'release', 'expire', 'release_amount',
  'allocate', 'capture_allocation', 'release_allocation',
  'deposit', 'withdrawal', 'withdrawal_return', 'chargeback', 'withdrawal_refusal',
  'creator_accrual', 'creator_payout_reserve', 'creator_payout', 'creator_payout_refusal', 'creator_payout_return',
  'redeem', 'credit_expiry'
));

-- migrate:down
-- Forward only: programme policy and source-to-journal bindings are retained.
