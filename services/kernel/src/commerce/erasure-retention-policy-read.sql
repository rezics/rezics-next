SELECT fields,purpose,expires_at::text AS "expiresAt"
FROM commerce.purchase_order_retention_policy
WHERE route=:route AND order_id=:order_id AND buyer_account_id=:account_id;
