DELETE FROM commerce.purchase_order_retained
WHERE route = :route AND buyer_account_id = :account_id AND order_id = ANY(:ids::uuid[])
  AND expires_at <= :now::timestamptz
RETURNING order_id AS id;
