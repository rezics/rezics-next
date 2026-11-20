-- migrate:up
CREATE TABLE economy.spot_instrument (
  book_id text NOT NULL,
  instrument_id text NOT NULL CHECK (instrument_id ~ '^[a-zA-Z0-9_-]{1,64}$'),
  policy_version bigint NOT NULL CHECK (policy_version > 0),
  base_asset_id text NOT NULL,
  quote_asset_id text NOT NULL,
  base_units_per_lot bigint NOT NULL CHECK (base_units_per_lot > 0),
  quote_units_per_price_tick bigint NOT NULL CHECK (quote_units_per_price_tick > 0),
  maker_fee_bps bigint NOT NULL CHECK (maker_fee_bps BETWEEN 0 AND 10000),
  taker_fee_bps bigint NOT NULL CHECK (taker_fee_bps BETWEEN 0 AND 10000),
  fee_account_id uuid NOT NULL CHECK (fee_account_id <> '00000000-0000-0000-0000-000000000000'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  matching_sequence bigint CHECK (matching_sequence > 0 AND matching_sequence <= revision),
  CHECK (base_asset_id <> quote_asset_id),
  PRIMARY KEY (book_id, instrument_id),
  FOREIGN KEY (book_id, base_asset_id) REFERENCES economy.asset (book_id, asset_id),
  FOREIGN KEY (book_id, quote_asset_id) REFERENCES economy.asset (book_id, asset_id)
);

CREATE TABLE economy.spot_order (
  book_id text NOT NULL,
  instrument_id text NOT NULL,
  order_id text NOT NULL CHECK (order_id ~ '^[a-zA-Z0-9_-]{1,64}$'),
  account_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  price bigint NOT NULL CHECK (price > 0),
  lots bigint NOT NULL CHECK (lots > 0),
  remaining_lots bigint NOT NULL CHECK (remaining_lots >= 0 AND remaining_lots <= lots),
  status text NOT NULL CHECK (status IN ('matching', 'resting', 'filled', 'cancelled')),
  reservation_id uuid NOT NULL,
  reserved_units_per_lot bigint NOT NULL CHECK (reserved_units_per_lot > 0),
  CHECK ((status = 'filled') = (remaining_lots = 0)),
  PRIMARY KEY (book_id, instrument_id, order_id),
  UNIQUE (book_id, instrument_id, sequence),
  FOREIGN KEY (book_id, instrument_id) REFERENCES economy.spot_instrument (book_id, instrument_id)
);

ALTER TABLE economy.spot_instrument ADD CONSTRAINT spot_active_order_exists
  FOREIGN KEY (book_id, instrument_id, matching_sequence) REFERENCES economy.spot_order (book_id, instrument_id, sequence);

CREATE UNIQUE INDEX spot_one_matching_order ON economy.spot_order (book_id, instrument_id) WHERE status = 'matching';
CREATE INDEX spot_ask_priority ON economy.spot_order (book_id, instrument_id, price, sequence)
  WHERE status = 'resting' AND side = 'sell';
CREATE INDEX spot_bid_priority ON economy.spot_order (book_id, instrument_id, price DESC, sequence)
  WHERE status = 'resting' AND side = 'buy';
CREATE INDEX spot_matching_ready ON economy.spot_instrument (book_id, instrument_id) WHERE matching_sequence IS NOT NULL;

CREATE TABLE economy.spot_match_step (
  book_id text NOT NULL,
  instrument_id text NOT NULL,
  from_revision bigint NOT NULL CHECK (from_revision > 0),
  order_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('matching', 'resting', 'filled', 'cancelled')),
  fill_ids text[] NOT NULL CHECK (cardinality(fill_ids) <= 32),
  PRIMARY KEY (book_id, instrument_id, from_revision),
  FOREIGN KEY (book_id, instrument_id, order_id) REFERENCES economy.spot_order (book_id, instrument_id, order_id)
);

CREATE TABLE economy.spot_fill (
  book_id text NOT NULL,
  fill_id text NOT NULL CHECK (length(fill_id) BETWEEN 1 AND 255),
  instrument_id text NOT NULL,
  maker_order_id text NOT NULL,
  taker_order_id text NOT NULL,
  buyer_id uuid NOT NULL,
  seller_id uuid NOT NULL,
  buyer_hold_id uuid NOT NULL,
  seller_hold_id uuid NOT NULL,
  lots bigint NOT NULL CHECK (lots > 0),
  price bigint NOT NULL CHECK (price > 0),
  base_units bigint NOT NULL CHECK (base_units > 0),
  quote_units bigint NOT NULL CHECK (quote_units > 0),
  buyer_fee_units bigint NOT NULL CHECK (buyer_fee_units >= 0),
  seller_fee_units bigint NOT NULL CHECK (seller_fee_units BETWEEN 0 AND quote_units),
  due_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  claim_id uuid,
  settled_at timestamptz,
  CHECK (maker_order_id <> taker_order_id AND buyer_id <> seller_id),
  CHECK (quote_units::numeric + buyer_fee_units <= 9223372036854775807),
  CHECK (settled_at IS NULL OR claim_id IS NOT NULL),
  PRIMARY KEY (book_id, fill_id),
  FOREIGN KEY (book_id, instrument_id, maker_order_id) REFERENCES economy.spot_order (book_id, instrument_id, order_id),
  FOREIGN KEY (book_id, instrument_id, taker_order_id) REFERENCES economy.spot_order (book_id, instrument_id, order_id)
);

CREATE INDEX spot_fill_ready ON economy.spot_fill (book_id, due_at, fill_id) WHERE settled_at IS NULL;

CREATE TRIGGER spot_instrument_terms_immutable
BEFORE UPDATE OF book_id, instrument_id, policy_version, base_asset_id, quote_asset_id, base_units_per_lot,
  quote_units_per_price_tick, maker_fee_bps, taker_fee_bps, fee_account_id OR DELETE ON economy.spot_instrument
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

CREATE TRIGGER spot_order_terms_immutable
BEFORE UPDATE OF book_id, instrument_id, order_id, account_id, sequence, side, price, lots, reservation_id,
  reserved_units_per_lot OR DELETE ON economy.spot_order
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

CREATE TRIGGER spot_fill_terms_immutable
BEFORE UPDATE OF book_id, fill_id, instrument_id, maker_order_id, taker_order_id, buyer_id, seller_id, buyer_hold_id,
  seller_hold_id, lots, price, base_units, quote_units, buyer_fee_units, seller_fee_units OR DELETE ON economy.spot_fill
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

CREATE TRIGGER spot_match_step_immutable BEFORE UPDATE OR DELETE ON economy.spot_match_step
FOR EACH ROW EXECUTE FUNCTION economy.reject_history_edit();

-- migrate:down
-- Forward only: spot order history identifies protected and settled obligations.
