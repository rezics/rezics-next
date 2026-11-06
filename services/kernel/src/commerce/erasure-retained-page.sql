SELECT order_id AS id
FROM commerce.purchase_order_retained
WHERE route = :route AND buyer_account_id = :account_id AND order_id > :after::uuid
  AND expires_at <= :now::timestamptz
ORDER BY order_id LIMIT 100;
