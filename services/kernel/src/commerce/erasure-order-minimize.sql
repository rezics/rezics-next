WITH input AS NOT MATERIALIZED (
  SELECT :route::integer AS route, :account_id::uuid AS account_id, :ids::uuid[] AS ids,
         :at::timestamptz AS at
), source AS MATERIALIZED (
  SELECT o.route,o.order_id,o.buyer_account_id,o.checkout_url,p.expires_at
  FROM commerce.purchase_order o
  JOIN commerce.purchase_order_retention_policy p
    ON (p.route,p.order_id,p.buyer_account_id)=(o.route,o.order_id,o.buyer_account_id)
  CROSS JOIN input i
  WHERE o.route=i.route AND o.buyer_account_id=i.account_id AND o.order_id=ANY(i.ids)
    AND o.checkout_minimized_at IS NULL AND o.checkout_url IS NOT NULL
  FOR UPDATE OF o
), retained AS (
  INSERT INTO commerce.purchase_order_retained(route,order_id,buyer_account_id,checkout_url,expires_at)
  SELECT route,order_id,buyer_account_id,checkout_url,expires_at FROM source
  ON CONFLICT(route,order_id) DO UPDATE SET
    buyer_account_id=EXCLUDED.buyer_account_id,
    checkout_url=EXCLUDED.checkout_url,
    expires_at=EXCLUDED.expires_at
  RETURNING route,order_id
), minimized AS (
  UPDATE commerce.purchase_order o
SET checkout_url=NULL,checkout_expires_at=NULL,checkout_minimized_at=i.at
FROM input i,source s LEFT JOIN retained r ON (r.route,r.order_id)=(s.route,s.order_id)
WHERE (o.route,o.order_id)=(s.route,s.order_id)
    AND (r.route,r.order_id)=(s.route,s.order_id)
  RETURNING o.route,o.order_id
), discarded AS (
  DELETE FROM commerce.purchase_order_retention_policy p USING minimized m
  WHERE (p.route,p.order_id)=(m.route,m.order_id)
)
SELECT order_id AS id FROM minimized;
