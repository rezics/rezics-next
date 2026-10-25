SELECT balance_transaction_id AS id FROM commerce.order_transaction
WHERE route = :route AND balance_transaction_id = ANY(:ids::text[]) AND order_id = :order_id
ORDER BY balance_transaction_id;
