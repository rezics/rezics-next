SELECT order_id AS id, buyer_account_id AS "buyerAccountId", content_edition::text AS "contentEdition", content_post::text AS "contentPost"
FROM commerce.purchase_order
WHERE route = :route AND buyer_account_id = :buyer_account_id
  AND ((content_edition IS NOT NULL AND content_edition->'benefit' = :benefit::text::jsonb)
    OR (content_post IS NOT NULL AND content_post->'benefit' = :benefit::text::jsonb))
  AND acquisition_release IS NULL
ORDER BY order_id LIMIT 1;
