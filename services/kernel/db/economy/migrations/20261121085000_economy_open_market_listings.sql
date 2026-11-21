-- migrate:up
CREATE INDEX market_listing_open_expiry_idx ON economy.market_listing
  (book_id, item_home_id, ((payload #>> '{expiresAt,$marketInteger}')::bigint), listing_id)
  WHERE payload ->> 'status' = 'open';

-- migrate:down
DROP INDEX economy.market_listing_open_expiry_idx;
