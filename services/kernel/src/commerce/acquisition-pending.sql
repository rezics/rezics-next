WITH input AS (
  SELECT :benefit::text::jsonb AS benefit
)
SELECT o.order_id AS id, o.buyer_account_id AS "buyerAccountId",
       o.content_edition::text AS "contentEdition", o.content_post::text AS "contentPost"
FROM commerce.purchase_order o
CROSS JOIN input i
WHERE o.route = :route AND o.buyer_account_id = :buyer_account_id
  AND ((o.content_edition IS NOT NULL AND o.content_edition->'benefit' = i.benefit)
    OR (o.content_post IS NOT NULL AND o.content_post->'benefit' = i.benefit))
  AND o.acquisition_release IS NULL
ORDER BY o.order_id LIMIT 1;
