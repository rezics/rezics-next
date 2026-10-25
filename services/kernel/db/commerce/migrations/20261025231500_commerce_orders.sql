-- migrate:up
CREATE SCHEMA commerce;

CREATE TABLE commerce.offer (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  offer_id uuid NOT NULL,
  creator_account_id uuid NOT NULL,
  target_subject_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor BETWEEN 1 AND 99999999),
  tax_code text NOT NULL CHECK (tax_code ~ '^txcd_[0-9]{8}$'),
  royalty_basis_points integer NOT NULL CHECK (royalty_basis_points BETWEEN 0 AND 10000),
  state text NOT NULL CHECK (state IN ('active', 'delisted')),
  revision integer NOT NULL CHECK (revision >= 1),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, offer_id),
  CHECK (route = get_byte(uuid_send(offer_id), 10) * 256 + get_byte(uuid_send(offer_id), 11)),
  CHECK (route = get_byte(uuid_send(creator_account_id), 10) * 256 + get_byte(uuid_send(creator_account_id), 11))
);

CREATE TABLE commerce.purchase_order (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  order_id uuid NOT NULL,
  buyer_account_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  offer_revision integer NOT NULL CHECK (offer_revision >= 1),
  creator_account_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor BETWEEN 1 AND 99999999),
  tax_code text NOT NULL CHECK (tax_code ~ '^txcd_[0-9]{8}$'),
  royalty_basis_points integer NOT NULL CHECK (royalty_basis_points BETWEEN 0 AND 10000),
  settlement text NOT NULL CHECK (settlement IN ('pending', 'paid', 'failed', 'unknown')),
  checkout_session_id text CHECK (checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]{1,250}$'),
  checkout_url text,
  checkout_expires_at timestamptz,
  payment_intent_id text CHECK (payment_intent_id ~ '^pi_[A-Za-z0-9]{1,250}$'),
  observed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, order_id),
  CHECK (route = get_byte(uuid_send(order_id), 10) * 256 + get_byte(uuid_send(order_id), 11)),
  CHECK (route = get_byte(uuid_send(buyer_account_id), 10) * 256 + get_byte(uuid_send(buyer_account_id), 11)),
  CHECK ((checkout_session_id IS NULL AND checkout_url IS NULL AND checkout_expires_at IS NULL)
      OR (checkout_session_id IS NOT NULL AND checkout_url IS NOT NULL AND checkout_expires_at IS NOT NULL))
);

CREATE UNIQUE INDEX purchase_order_checkout_session ON commerce.purchase_order (route, checkout_session_id)
WHERE checkout_session_id IS NOT NULL;

-- Identity and captured terms depend only on this row, never another partition.
CREATE FUNCTION commerce.guard_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.route, NEW.order_id, NEW.buyer_account_id, NEW.offer_id, NEW.offer_revision,
      NEW.creator_account_id, NEW.title, NEW.currency, NEW.unit_amount_minor, NEW.tax_code,
      NEW.royalty_basis_points, NEW.created_at)
     IS DISTINCT FROM
     (OLD.route, OLD.order_id, OLD.buyer_account_id, OLD.offer_id, OLD.offer_revision,
      OLD.creator_account_id, OLD.title, OLD.currency, OLD.unit_amount_minor, OLD.tax_code,
      OLD.royalty_basis_points, OLD.created_at) THEN
    RAISE EXCEPTION 'Order identity and captured offer terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.checkout_session_id IS NOT NULL AND
     (NEW.checkout_session_id, NEW.checkout_url, NEW.checkout_expires_at)
     IS DISTINCT FROM (OLD.checkout_session_id, OLD.checkout_url, OLD.checkout_expires_at) THEN
    RAISE EXCEPTION 'Recorded checkout session is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.settlement = 'paid' AND NEW.settlement <> 'paid' THEN
    RAISE EXCEPTION 'Paid settlement cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER purchase_order_guard BEFORE UPDATE ON commerce.purchase_order
FOR EACH ROW EXECUTE FUNCTION commerce.guard_order();

CREATE TABLE commerce.order_transaction (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  order_id uuid NOT NULL,
  balance_transaction_id text NOT NULL CHECK (balance_transaction_id ~ '^txn_[A-Za-z0-9]{1,250}$'),
  kind text NOT NULL CHECK (kind IN ('charge', 'refund', 'refund_reversal', 'dispute', 'dispute_reversal')),
  source_id text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  amount_minor bigint NOT NULL,
  fee_minor bigint NOT NULL,
  net_minor bigint NOT NULL CHECK (net_minor = amount_minor - fee_minor),
  fee_details jsonb NOT NULL CHECK (jsonb_typeof(fee_details) = 'array'),
  exchange_rate numeric,
  stripe_created timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, balance_transaction_id),
  CHECK (route = get_byte(uuid_send(order_id), 10) * 256 + get_byte(uuid_send(order_id), 11))
);
CREATE INDEX order_transaction_order ON commerce.order_transaction (route, order_id);

CREATE FUNCTION commerce.guard_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Recorded Stripe transactions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER order_transaction_guard BEFORE UPDATE OR DELETE ON commerce.order_transaction
FOR EACH ROW EXECUTE FUNCTION commerce.guard_transaction();

CREATE TABLE commerce.entitlement (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  entitlement_id uuid NOT NULL,
  account_id uuid NOT NULL,
  order_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  target_subject_id uuid NOT NULL,
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IN ('refund', 'dispute')),
  revision integer NOT NULL CHECK (revision >= 1),
  transaction_id uuid NOT NULL,
  PRIMARY KEY (route, entitlement_id),
  UNIQUE (route, order_id),
  CHECK (route = get_byte(uuid_send(entitlement_id), 10) * 256 + get_byte(uuid_send(entitlement_id), 11)),
  CHECK (route = get_byte(uuid_send(account_id), 10) * 256 + get_byte(uuid_send(account_id), 11)),
  CHECK (route = get_byte(uuid_send(order_id), 10) * 256 + get_byte(uuid_send(order_id), 11)),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX entitlement_account_page ON commerce.entitlement (route, account_id, entitlement_id);

CREATE FUNCTION commerce.guard_entitlement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.route, NEW.entitlement_id, NEW.account_id, NEW.order_id, NEW.offer_id,
      NEW.target_subject_id, NEW.granted_at)
     IS DISTINCT FROM
     (OLD.route, OLD.entitlement_id, OLD.account_id, OLD.order_id, OLD.offer_id,
      OLD.target_subject_id, OLD.granted_at) THEN
    RAISE EXCEPTION 'Entitlement identity and benefit are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER entitlement_guard BEFORE UPDATE ON commerce.entitlement
FOR EACH ROW EXECUTE FUNCTION commerce.guard_entitlement();

-- migrate:down
-- Forward only: orders, financial records and benefits must not be discarded by rollback.
