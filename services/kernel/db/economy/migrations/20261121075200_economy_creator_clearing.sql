-- migrate:up
ALTER TABLE economy.position DROP CONSTRAINT position_account_role_check, DROP CONSTRAINT position_balance_by_role_check;
ALTER TABLE economy.position
  ADD CONSTRAINT position_account_role_check CHECK (account_role IN (
    'wallet', 'issuer', 'provider_clearing', 'chargeback_receivable', 'creator_expense', 'creator_payable'
  )),
  ADD CONSTRAINT position_balance_by_role_check CHECK (
    (account_role = 'wallet' AND posted >= held::numeric + restricted)
    OR (account_role = 'creator_payable' AND posted >= held AND restricted = 0)
    OR (account_role NOT IN ('wallet', 'creator_payable') AND held = 0 AND restricted = 0)
  );
ALTER TABLE economy.funding_control_account DROP CONSTRAINT funding_control_account_account_role_check;
ALTER TABLE economy.funding_control_account ADD CONSTRAINT funding_control_account_account_role_check
  CHECK (account_role IN ('provider_clearing', 'chargeback_receivable', 'creator_expense', 'creator_payable'));

ALTER TABLE economy.journal DROP CONSTRAINT journal_kind_check;
ALTER TABLE economy.journal ADD CONSTRAINT journal_kind_check CHECK (kind IN (
  'issue', 'transfer', 'reserve', 'capture', 'release', 'expire', 'release_amount',
  'allocate', 'capture_allocation', 'release_allocation',
  'deposit', 'withdrawal', 'withdrawal_return', 'chargeback', 'withdrawal_refusal',
  'creator_accrual', 'creator_payout_reserve', 'creator_payout', 'creator_payout_refusal', 'creator_payout_return'
));

CREATE TABLE economy.creator_payout (
  book_id text NOT NULL,
  payout_id text NOT NULL CHECK (char_length(payout_id) BETWEEN 1 AND 64),
  creator_id uuid NOT NULL CHECK (creator_id <> '00000000-0000-0000-0000-000000000000'),
  asset_id text NOT NULL,
  units bigint NOT NULL CHECK (units > 0),
  provider_namespace text NOT NULL CHECK (char_length(provider_namespace) BETWEEN 1 AND 255),
  provider_mode text NOT NULL CHECK (provider_mode IN ('test', 'live')),
  destination_ref text NOT NULL CHECK (char_length(destination_ref) BETWEEN 1 AND 255),
  status text NOT NULL CHECK (status IN ('reserved', 'paid', 'released')),
  paid_movement_id text CHECK (char_length(paid_movement_id) BETWEEN 1 AND 255),
  returned_units bigint NOT NULL DEFAULT 0 CHECK (returned_units BETWEEN 0 AND units),
  reserve_transaction_id uuid NOT NULL,
  PRIMARY KEY (book_id, payout_id),
  UNIQUE (book_id, asset_id, reserve_transaction_id),
  FOREIGN KEY (book_id, asset_id, reserve_transaction_id) REFERENCES economy.journal,
  CHECK ((status = 'paid') = (paid_movement_id IS NOT NULL)),
  CHECK (status = 'paid' OR returned_units = 0)
);

CREATE TABLE economy.creator_posting (
  source_namespace text NOT NULL CHECK (char_length(source_namespace) BETWEEN 1 AND 255),
  source_mode text NOT NULL CHECK (source_mode IN ('owner', 'test', 'live')),
  source_kind text NOT NULL CHECK (source_kind IN ('accrual', 'movement', 'refusal')),
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 255),
  book_id text NOT NULL,
  asset_id text NOT NULL,
  payout_id text,
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (source_namespace, source_mode, source_kind, source_id),
  UNIQUE (book_id, asset_id, transaction_id),
  FOREIGN KEY (book_id, payout_id) REFERENCES economy.creator_payout,
  FOREIGN KEY (book_id, asset_id, transaction_id) REFERENCES economy.journal,
  CHECK ((source_kind = 'accrual') = (source_mode = 'owner')),
  CHECK ((source_kind = 'accrual') = (payout_id IS NULL))
);

-- Provider movement identity belongs to the provider account and mode across both payout domains.
CREATE TABLE economy.provider_posting_key (
  provider_namespace text NOT NULL,
  provider_mode text NOT NULL CHECK (provider_mode IN ('test', 'live')),
  source_kind text NOT NULL CHECK (source_kind IN ('movement', 'refusal')),
  source_id text NOT NULL,
  owner text NOT NULL CHECK (owner IN ('wallet_funding', 'creator_payout')),
  PRIMARY KEY (provider_namespace, provider_mode, source_kind, source_id)
);
INSERT INTO economy.provider_posting_key
  SELECT provider_namespace, provider_mode, source_kind, source_id, 'wallet_funding' FROM economy.funding_posting;

CREATE FUNCTION economy.claim_funding_posting_key() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO economy.provider_posting_key VALUES (
    NEW.provider_namespace, NEW.provider_mode, NEW.source_kind, NEW.source_id, 'wallet_funding'
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER funding_posting_evidence_identity BEFORE INSERT ON economy.funding_posting
  FOR EACH ROW EXECUTE FUNCTION economy.claim_funding_posting_key();
CREATE TRIGGER creator_posting_immutable BEFORE UPDATE OR DELETE ON economy.creator_posting
  FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();
CREATE TRIGGER provider_posting_key_immutable BEFORE UPDATE OR DELETE ON economy.provider_posting_key
  FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

-- migrate:down
-- Forward only: accrued liabilities and provider posting identities must be preserved.
