-- migrate:up
-- Disposable creator-home accounting projection; purchase_order remains the sole order authority.
CREATE TABLE commerce.creator_sale (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  creator_account_id uuid NOT NULL,
  order_id uuid NOT NULL,
  offer_id uuid NOT NULL,
  target_subject_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) <= 512 AND octet_length(title) <= 2048),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor BETWEEN 1 AND 99999999),
  money_unit jsonb,
  tax_behavior text CHECK (tax_behavior = 'exclusive'),
  settlement text NOT NULL CHECK (settlement IN ('pending','paid','failed','unknown')),
  created_at timestamptz NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  source_transaction_id uuid NOT NULL,
  source_epoch bigint NOT NULL CHECK (source_epoch >= 1),
  source_position bigint NOT NULL CHECK (source_position >= 1),
  source_event_seq integer NOT NULL CHECK (source_event_seq BETWEEN 0 AND 999),
  source_event_id uuid NOT NULL,
  PRIMARY KEY (route, creator_account_id, order_id),
  CHECK (route = (get_byte(uuid_send(creator_account_id),10)*256+get_byte(uuid_send(creator_account_id),11))),
  CHECK (money_unit IS NULL OR money_unit IN (
    '{"system":"stripe-api","exponent":0,"factsVersion":"stripe-money-v1"}'::jsonb,
    '{"system":"stripe-api","exponent":2,"factsVersion":"stripe-money-v1"}'::jsonb))
);
-- Exact source-home locator and retry state. No copied terms, Actor or permission result.
CREATE TABLE commerce.creator_sale_work (
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  order_id uuid NOT NULL,
  generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
  observed_revision integer,
  observed_transaction_id uuid,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verified')),
  gap text,
  next_run timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (route,order_id),
  CHECK (route = (get_byte(uuid_send(order_id),10)*256+get_byte(uuid_send(order_id),11)))
);
CREATE INDEX creator_sale_work_pending ON commerce.creator_sale_work (route,next_run,order_id) WHERE state='pending';
-- Native custody obligation survives queue dispatch and is never a financial response receipt.
CREATE TABLE commerce.creator_sale_receipt (
  partition_no integer NOT NULL CHECK (partition_no BETWEEN 0 AND 4095),
  position bigint NOT NULL CHECK (position >= 1),
  event_seq integer NOT NULL CHECK (event_seq BETWEEN 0 AND 999),
  epoch bigint NOT NULL CHECK (epoch >= 1),
  event_id uuid NOT NULL,
  route integer NOT NULL CHECK (route BETWEEN 0 AND 65535),
  order_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','minimized')),
  PRIMARY KEY (partition_no,position,event_seq),
  CHECK (partition_no = route >> 4),
  CHECK (route = (get_byte(uuid_send(order_id),10)*256+get_byte(uuid_send(order_id),11)))
);
CREATE INDEX creator_sale_receipt_order ON commerce.creator_sale_receipt(route,order_id,position,event_seq);
CREATE TABLE commerce.creator_sales_frontier (
  partition_no integer PRIMARY KEY CHECK (partition_no BETWEEN 0 AND 4095),
  epoch bigint NOT NULL CHECK (epoch >= 1),
  after_route integer NOT NULL,
  after_order uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  phase text NOT NULL DEFAULT 'scanning' CHECK (phase IN ('scanning','covered')),
  CHECK (after_route BETWEEN partition_no*16 AND partition_no*16+15)
);

-- migrate:down
DROP TABLE commerce.creator_sales_frontier;
DROP TABLE commerce.creator_sale_receipt;
DROP TABLE commerce.creator_sale_work;
DROP TABLE commerce.creator_sale;
