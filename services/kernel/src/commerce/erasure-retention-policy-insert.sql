INSERT INTO commerce.purchase_order_retention_policy(route,order_id,buyer_account_id,fields,purpose,expires_at)
SELECT o.route,o.order_id,o.buyer_account_id,:fields::text[],:purpose::text,:expires_at::timestamptz
FROM commerce.purchase_order o
JOIN access.account a ON (a.route,a.account_id)=(o.route,o.buyer_account_id)
WHERE o.route=:route AND o.order_id=:order_id AND o.checkout_session_id IS NOT NULL
  AND o.checkout_url IS NOT NULL AND o.checkout_minimized_at IS NULL
  AND a.state='active'
  AND NOT EXISTS (SELECT 1 FROM access.erasure e WHERE (e.route,e.account_id)=(o.route,o.buyer_account_id))
ON CONFLICT(route,order_id) DO NOTHING
RETURNING order_id AS id;
