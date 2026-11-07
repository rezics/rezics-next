SELECT fields,purpose,
       to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "expiresAt"
FROM commerce.purchase_order_retention_policy
WHERE route=:route AND order_id=:order_id AND buyer_account_id=:account_id;
