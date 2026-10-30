-- Called only after verified native creation/refresh and its revision fences in this transaction.
UPDATE commerce.purchase_order SET acquisition_release = NULLIF(:disposition::text, '')
WHERE route = :route AND order_id = :order_id AND buyer_account_id = :buyer_account_id
  AND revision = :revision AND content_edition IS NOT NULL
  AND acquisition_release IS DISTINCT FROM NULLIF(:disposition::text, '')
RETURNING order_id AS id;
