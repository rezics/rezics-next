-- Exact account/benefit partial-index seek, not a subject or offer/history scan.
SELECT entitlement_id AS id, order_id AS "orderId", account_id AS "accountId", content_edition::text AS "contentEdition", content_post::text AS "contentPost"
FROM commerce.entitlement
WHERE route = :route AND account_id = :buyer_account_id
  AND ((content_edition IS NOT NULL AND content_edition->'benefit' = :benefit::text::jsonb)
    OR (content_post IS NOT NULL AND content_post->'benefit' = :benefit::text::jsonb))
  AND revoked_at IS NULL AND revoke_reason IS NULL
ORDER BY entitlement_id LIMIT 1;
