-- migrate:up
CREATE INDEX spot_order_owner_sequence
  ON economy.spot_order (book_id, account_id, instrument_id, sequence DESC);

-- migrate:down
DROP INDEX economy.spot_order_owner_sequence;
