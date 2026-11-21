-- migrate:up
CREATE TABLE economy.commerce_evidence_receipt (
  provider_namespace text NOT NULL CHECK (provider_namespace ~ '^[A-Za-z0-9_-]{1,64}$'),
  provider_mode text NOT NULL CHECK (provider_mode = 'test'),
  movement_id text NOT NULL CHECK (movement_id ~ '^txn_[A-Za-z0-9]{1,250}$'),
  book_id text NOT NULL CHECK (book_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'),
  order_id uuid NOT NULL,
  creator_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  statement_id uuid NOT NULL,
  source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 255),
  movement_kind text NOT NULL CHECK (movement_kind IN ('charge', 'refund', 'refund_reversal', 'dispute', 'dispute_reversal')),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  unit jsonb NOT NULL,
  amount_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  net_minor bigint NOT NULL CHECK (net_minor::numeric = amount_minor::numeric - fee_minor),
  economic_digest text NOT NULL CHECK (economic_digest ~ '^[0-9a-f]{64}$'),
  registered_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (provider_namespace, provider_mode, movement_id)
);

CREATE TRIGGER commerce_evidence_immutable BEFORE UPDATE OR DELETE ON economy.commerce_evidence_receipt
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

-- migrate:down
-- Financial evidence receipts are forward only.
