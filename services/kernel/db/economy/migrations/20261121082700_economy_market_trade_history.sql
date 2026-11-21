-- migrate:up
CREATE INDEX market_trade_buyer_history_idx ON economy.market_trade
  (book_id, (payload #>> '{terms,item,homeId}'), (payload #>> '{buyer,buyerId}'),
   ((payload #>> '{buyer,startedAt,$marketInteger}')::bigint) DESC, trade_id DESC);

CREATE INDEX market_trade_seller_history_idx ON economy.market_trade
  (book_id, (payload #>> '{terms,item,homeId}'), (payload #>> '{terms,item,holderId}'),
   ((payload #>> '{buyer,startedAt,$marketInteger}')::bigint) DESC, trade_id DESC);

-- migrate:down
DROP INDEX economy.market_trade_seller_history_idx;
DROP INDEX economy.market_trade_buyer_history_idx;
