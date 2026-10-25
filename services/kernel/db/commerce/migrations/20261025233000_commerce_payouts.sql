-- migrate:up
ALTER TABLE commerce.purchase_order ADD COLUMN amount_tax_minor bigint CHECK (amount_tax_minor >= 0);
CREATE FUNCTION commerce.guard_order_tax() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.settlement = 'paid' AND NEW.amount_tax_minor IS DISTINCT FROM OLD.amount_tax_minor THEN
    RAISE EXCEPTION 'Paid Checkout tax evidence is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_order_tax_guard BEFORE UPDATE ON commerce.purchase_order
FOR EACH ROW EXECUTE FUNCTION commerce.guard_order_tax();

CREATE TABLE commerce.payout_statement (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  statement_id uuid NOT NULL,
  creator_account_id uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  gross_minor bigint NOT NULL DEFAULT 0,
  tax_minor bigint NOT NULL DEFAULT 0,
  fee_minor bigint NOT NULL DEFAULT 0,
  dispute_fee_minor bigint NOT NULL DEFAULT 0,
  refunds_minor bigint NOT NULL DEFAULT 0,
  chargebacks_minor bigint NOT NULL DEFAULT 0,
  net_receipts_minor bigint NOT NULL DEFAULT 0 CHECK (net_receipts_minor = gross_minor - tax_minor - fee_minor),
  -- Keep the numerator, including its fractional minor units, across every incremental addition.
  weighted_net_minor numeric NOT NULL DEFAULT 0 CHECK (weighted_net_minor = trunc(weighted_net_minor)),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'paid')),
  paid_at timestamptz,
  paid_reference text CHECK (char_length(btrim(paid_reference)) BETWEEN 1 AND 256),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  PRIMARY KEY (route, statement_id),
  UNIQUE (route, creator_account_id, period, currency),
  CHECK (route = get_byte(uuid_send(statement_id), 10) * 256 + get_byte(uuid_send(statement_id), 11)),
  CHECK (route = get_byte(uuid_send(creator_account_id), 10) * 256 + get_byte(uuid_send(creator_account_id), 11)),
  CHECK ((state = 'open' AND paid_at IS NULL AND paid_reference IS NULL)
      OR (state = 'paid' AND paid_at IS NOT NULL AND paid_reference IS NOT NULL))
);
CREATE INDEX payout_statement_creator_page ON commerce.payout_statement (route, creator_account_id, statement_id);

CREATE FUNCTION commerce.guard_payout_statement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'paid' OR
    (NEW.route, NEW.statement_id, NEW.creator_account_id, NEW.period, NEW.currency)
    IS DISTINCT FROM (OLD.route, OLD.statement_id, OLD.creator_account_id, OLD.period, OLD.currency) THEN
    RAISE EXCEPTION 'Statement identity and paid statements are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'paid' AND NEW.period >= to_char(NEW.paid_at AT TIME ZONE 'UTC', 'YYYY-MM') THEN
    RAISE EXCEPTION 'Only a completed UTC month can be paid' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payout_statement_guard BEFORE UPDATE ON commerce.payout_statement
FOR EACH ROW EXECUTE FUNCTION commerce.guard_payout_statement();

CREATE TABLE commerce.royalty_line (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  balance_transaction_id text NOT NULL CHECK (balance_transaction_id ~ '^txn_[A-Za-z0-9]{1,250}$'),
  creator_account_id uuid NOT NULL,
  order_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('charge', 'refund', 'refund_reversal', 'dispute', 'dispute_reversal')),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  gross_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  dispute_fee_minor bigint NOT NULL,
  net_receipts_minor bigint NOT NULL CHECK (net_receipts_minor = gross_minor - tax_minor - fee_minor),
  royalty_basis_points integer NOT NULL CHECK (royalty_basis_points BETWEEN 0 AND 10000),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  statement_id uuid NOT NULL,
  stripe_created timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (route, balance_transaction_id),
  CHECK (route = get_byte(uuid_send(creator_account_id), 10) * 256 + get_byte(uuid_send(creator_account_id), 11)),
  CHECK (route = get_byte(uuid_send(statement_id), 10) * 256 + get_byte(uuid_send(statement_id), 11)),
  CHECK (route = get_byte(uuid_send(offer_id), 10) * 256 + get_byte(uuid_send(offer_id), 11))
);
CREATE INDEX royalty_line_statement_page ON commerce.royalty_line (route, statement_id, balance_transaction_id);
CREATE TRIGGER royalty_line_guard BEFORE UPDATE OR DELETE ON commerce.royalty_line
FOR EACH ROW EXECUTE FUNCTION commerce.guard_transaction();

-- migrate:down
-- Financial records are forward only.
