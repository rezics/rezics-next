-- migrate:up
ALTER TABLE economy.position ADD COLUMN account_role text NOT NULL DEFAULT 'wallet';
UPDATE economy.position SET account_role = 'issuer' WHERE account_id = '00000000-0000-0000-0000-000000000000';
ALTER TABLE economy.position DROP CONSTRAINT position_check1;
ALTER TABLE economy.position
  ADD CONSTRAINT position_account_role_check
    CHECK (account_role IN ('wallet', 'issuer', 'provider_clearing', 'chargeback_receivable')),
  ADD CONSTRAINT position_issuer_role_check
    CHECK ((account_role = 'issuer') = (account_id = '00000000-0000-0000-0000-000000000000')),
  ADD CONSTRAINT position_balance_by_role_check CHECK (
    (account_role = 'wallet' AND posted >= held::numeric + restricted)
    OR (account_role <> 'wallet' AND held = 0 AND restricted = 0)
  );

CREATE TABLE economy.funding_control_account (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  account_role text NOT NULL CHECK (account_role IN ('provider_clearing', 'chargeback_receivable')),
  reference text NOT NULL CHECK (char_length(reference) BETWEEN 1 AND 263),
  account_id uuid NOT NULL CHECK (account_id <> '00000000-0000-0000-0000-000000000000'),
  PRIMARY KEY (book_id, asset_id, account_role, reference),
  UNIQUE (book_id, asset_id, account_id),
  FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset
);

ALTER TABLE economy.journal DROP CONSTRAINT journal_kind_check, DROP CONSTRAINT journal_hold_kind_check;
ALTER TABLE economy.journal ADD CONSTRAINT journal_kind_check CHECK (kind IN (
  'issue', 'transfer', 'reserve', 'capture', 'release', 'expire', 'release_amount',
  'allocate', 'capture_allocation', 'release_allocation',
  'deposit', 'withdrawal', 'withdrawal_return', 'chargeback', 'withdrawal_refusal'
));
ALTER TABLE economy.journal ADD CONSTRAINT journal_hold_kind_check CHECK ((kind IN (
  'reserve', 'capture', 'release', 'expire', 'release_amount', 'allocate',
  'capture_allocation', 'release_allocation', 'withdrawal', 'withdrawal_refusal'
)) = (hold_id IS NOT NULL));

CREATE TABLE economy.funding_posting (
  provider_namespace text NOT NULL,
  provider_mode text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  book_id text NOT NULL,
  asset_id text NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (provider_namespace, provider_mode, source_kind, source_id),
  UNIQUE (book_id, asset_id, transaction_id),
  FOREIGN KEY (provider_namespace, provider_mode, source_kind, source_id) REFERENCES economy.funding_evidence,
  FOREIGN KEY (book_id, asset_id, transaction_id) REFERENCES economy.journal
);

CREATE TRIGGER funding_control_account_immutable BEFORE UPDATE OR DELETE ON economy.funding_control_account
  FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();
CREATE TRIGGER funding_posting_immutable BEFORE UPDATE OR DELETE ON economy.funding_posting
  FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

-- migrate:down
-- Forward only: role identities and evidence-bound postings must be preserved.
