SELECT 1 AS present FROM commerce.order_transaction
WHERE route = :route AND order_id = :order_id
LIMIT 257;
