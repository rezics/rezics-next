-- migrate:up
CREATE INDEX purchase_order_buyer_page ON commerce.purchase_order (route, buyer_account_id, order_id);

-- migrate:down
DROP INDEX commerce.purchase_order_buyer_page;
