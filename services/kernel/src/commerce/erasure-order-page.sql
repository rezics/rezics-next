SELECT o.order_id AS id, o.checkout_url IS NOT NULL AS "hasCheckoutUrl",
       o.checkout_minimized_at IS NOT NULL AS minimized,
       p.fields, p.purpose,
       to_char(p.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt"
FROM commerce.purchase_order o
LEFT JOIN commerce.purchase_order_retention_policy p
  ON (p.route,p.order_id,p.buyer_account_id)=(o.route,o.order_id,o.buyer_account_id)
WHERE o.route = :route AND o.buyer_account_id = :account_id AND o.order_id > :after::uuid
ORDER BY o.order_id LIMIT 100;
