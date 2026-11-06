SELECT order_id AS "orderId", buyer_account_id AS "buyerAccountId", checkout_url AS "checkoutUrl",
       to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt"
FROM commerce.purchase_order_retained
WHERE route=:route AND order_id=:order_id;
