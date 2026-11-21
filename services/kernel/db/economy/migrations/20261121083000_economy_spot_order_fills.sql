-- migrate:up
CREATE INDEX spot_fill_maker_order
  ON economy.spot_fill (book_id, instrument_id, maker_order_id, fill_id DESC);

CREATE INDEX spot_fill_taker_order
  ON economy.spot_fill (book_id, instrument_id, taker_order_id, fill_id DESC);

-- migrate:down
DROP INDEX economy.spot_fill_taker_order;
DROP INDEX economy.spot_fill_maker_order;
