-- Called only after verified native creation/refresh and its revision fences in this transaction.
WITH input AS NOT MATERIALIZED (SELECT NULLIF(:disposition::text, '') AS disposition)
UPDATE commerce.purchase_order SET acquisition_release = input.disposition
FROM input
WHERE route = :route AND order_id = :order_id AND buyer_account_id = :buyer_account_id
  AND revision = :revision AND content_edition IS NOT NULL
  AND acquisition_release IS DISTINCT FROM input.disposition
RETURNING order_id AS id;
