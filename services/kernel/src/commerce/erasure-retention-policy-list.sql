SELECT fields,purpose,expires_at::text AS "expiresAt"
FROM commerce.purchase_order_retention_policy
WHERE route=:route AND buyer_account_id=:account_id
ORDER BY order_id LIMIT 1;
