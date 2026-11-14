-- Exact account/benefit partial-index seek, not a subject or offer/history scan.
WITH input AS (
  SELECT :benefit::text::jsonb AS benefit
)
SELECT e.entitlement_id AS id, e.order_id AS "orderId", e.account_id AS "accountId",
       e.content_edition::text AS "contentEdition", e.content_post::text AS "contentPost"
FROM commerce.entitlement e
CROSS JOIN input i
WHERE e.route = :route AND e.account_id = :buyer_account_id
  AND ((e.content_edition IS NOT NULL AND e.content_edition->'benefit' = i.benefit)
    OR (e.content_post IS NOT NULL AND e.content_post->'benefit' = i.benefit))
  AND e.revoked_at IS NULL AND e.revoke_reason IS NULL
ORDER BY e.entitlement_id LIMIT 1;
