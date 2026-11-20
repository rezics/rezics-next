-- migrate:up
CREATE SCHEMA economy;

CREATE TABLE economy.asset (
  book_id text NOT NULL CHECK (char_length(book_id) BETWEEN 1 AND 64),
  asset_id text NOT NULL CHECK (char_length(asset_id) BETWEEN 1 AND 64),
  scale smallint NOT NULL CHECK (scale BETWEEN 0 AND 18),
  transferable boolean NOT NULL,
  PRIMARY KEY (book_id, asset_id)
);

CREATE TABLE economy.position (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  account_id uuid NOT NULL,
  posted bigint NOT NULL DEFAULT 0,
  held bigint NOT NULL DEFAULT 0,
  restricted bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (book_id, asset_id, account_id),
  FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset,
  CHECK (held >= 0 AND restricted >= 0),
  CHECK (
    (account_id = '00000000-0000-0000-0000-000000000000' AND held = 0 AND restricted = 0)
    OR (posted >= 0 AND held::numeric + restricted <= posted)
  )
);

CREATE TABLE economy.command_receipt (
  book_id text NOT NULL,
  origin_id uuid NOT NULL,
  namespace text NOT NULL CHECK (namespace IN ('wallet', 'owner')),
  operation_id text NOT NULL CHECK (char_length(operation_id) BETWEEN 1 AND 255),
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  outcome text NOT NULL CHECK (outcome IN (
    'ok', 'asset_missing', 'operation_conflict', 'insufficient_funds', 'asset_not_transferable',
    'hold_missing', 'hold_closed', 'invalid_amount', 'invalid_operation'
  )),
  PRIMARY KEY (book_id, origin_id, namespace, operation_id)
);

CREATE TABLE economy.journal (
  book_id text NOT NULL,
  origin_id uuid NOT NULL,
  namespace text NOT NULL,
  operation_id text NOT NULL,
  asset_id text NOT NULL,
  transaction_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('issue', 'transfer', 'reserve', 'capture', 'release', 'expire')),
  hold_id text,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (book_id, asset_id, transaction_id),
  UNIQUE (book_id, origin_id, namespace, operation_id),
  FOREIGN KEY (book_id, asset_id) REFERENCES economy.asset,
  FOREIGN KEY (book_id, origin_id, namespace, operation_id) REFERENCES economy.command_receipt,
  CHECK ((kind = 'transfer') = (namespace = 'wallet')),
  CHECK ((kind IN ('reserve', 'capture', 'release', 'expire')) = (hold_id IS NOT NULL))
);

CREATE TABLE economy.entry (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  account_id uuid NOT NULL,
  position bigint NOT NULL CHECK (position > 0),
  transaction_id uuid NOT NULL,
  posted_delta bigint NOT NULL,
  held_delta bigint NOT NULL,
  PRIMARY KEY (book_id, asset_id, account_id, position),
  UNIQUE (book_id, asset_id, transaction_id, account_id),
  FOREIGN KEY (book_id, asset_id, account_id) REFERENCES economy.position,
  FOREIGN KEY (book_id, asset_id, transaction_id) REFERENCES economy.journal,
  CHECK (posted_delta <> 0 OR held_delta <> 0)
);

CREATE TABLE economy.hold (
  book_id text NOT NULL,
  asset_id text NOT NULL,
  account_id uuid NOT NULL CHECK (account_id <> '00000000-0000-0000-0000-000000000000'),
  hold_id text NOT NULL CHECK (char_length(hold_id) BETWEEN 1 AND 255),
  reserve_transaction_id uuid NOT NULL,
  original bigint NOT NULL CHECK (original > 0),
  remaining bigint NOT NULL CHECK (remaining >= 0),
  captured bigint NOT NULL DEFAULT 0 CHECK (captured >= 0),
  released bigint NOT NULL DEFAULT 0 CHECK (released >= 0),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  PRIMARY KEY (book_id, asset_id, account_id, hold_id),
  FOREIGN KEY (book_id, asset_id, account_id) REFERENCES economy.position,
  FOREIGN KEY (book_id, asset_id, reserve_transaction_id) REFERENCES economy.journal,
  CHECK (original = remaining::numeric + captured + released),
  CHECK ((remaining = 0) = (closed_at IS NOT NULL))
);

CREATE INDEX hold_due_idx ON economy.hold (book_id, expires_at, asset_id, account_id, hold_id) WHERE remaining > 0;

CREATE FUNCTION economy.reject_history_edit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Economy history and asset definitions are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER asset_immutable BEFORE UPDATE OR DELETE ON economy.asset
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();
CREATE TRIGGER receipt_immutable BEFORE UPDATE OR DELETE ON economy.command_receipt
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON economy.journal
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();
CREATE TRIGGER entry_immutable BEFORE UPDATE OR DELETE ON economy.entry
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

-- migrate:down
-- Forward only: posted transactions and economic identities must be preserved.
