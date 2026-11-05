SELECT order_id AS "orderId", buyer_account_id AS "buyerAccountId", checkout_url AS "checkoutUrl",
       expires_at::text AS "expiresAt"
FROM commerce.purchase_order_retained
WHERE route=:route AND order_id=:order_id;
