-- migrate:up
CREATE INDEX spot_fill_settled_feed
  ON economy.spot_fill (book_id, instrument_id, settled_at DESC, fill_id DESC)
  WHERE settled_at IS NOT NULL;

-- migrate:down
DROP INDEX economy.spot_fill_settled_feed;
